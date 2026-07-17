import {
  apiErrorSchema,
  runtimeStatusSchema,
  taskEventSchema,
  taskOutputChunkSchema,
  taskSummarySchema,
  tokenRotationResponseSchema,
  workerAssignmentSchema,
  workerRegistrationSchema,
  workerSchema,
  workspaceOwnershipSchema,
  type ApiError,
  type RuntimeStatus,
  type TaskEvent,
  type TaskOutputChunk,
  type TaskSummary,
  type Worker,
  type WorkerAssignment,
  type WorkerRegistrationInput,
  type WorkspaceOwnership,
} from '@praxrail/core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  NodeHttpTransport,
  type ClientTransport,
  type TransportRequest,
} from './transport.js';

export class PraxrailClientError extends Error {
  constructor(
    readonly status: number,
    readonly detail: ApiError,
  ) {
    super(detail.message);
    this.name = 'PraxrailClientError';
  }
}

export interface PraxrailClientOptions {
  endpoint: string;
  token: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  allowInsecureRemote?: boolean;
  transport?: ClientTransport;
}

const eventPageSchema = z
  .object({
    events: z.array(taskEventSchema),
    nextCursor: z.number().int().nonnegative(),
  })
  .strict();

const outputPageSchema = z
  .object({
    chunks: z.array(taskOutputChunkSchema),
    nextCursor: z.number().int().nonnegative(),
  })
  .strict();

export class PraxrailClient {
  private readonly transport: ClientTransport;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(private readonly options: PraxrailClientOptions) {
    if (options.token.length < 32) throw new Error('API token is too short');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = Math.max(0, Math.min(options.maxRetries ?? 2, 5));
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 100);
    this.transport =
      options.transport ??
      new NodeHttpTransport(
        options.endpoint,
        options.allowInsecureRemote ?? false,
      );
  }

  async runtimeStatus(): Promise<RuntimeStatus> {
    return runtimeStatusSchema.parse(
      await this.request('GET', '/api/v1/runtime'),
    );
  }

  async listTasks(limit = 50): Promise<TaskSummary[]> {
    const result = await this.request(
      'GET',
      `/api/v1/tasks?limit=${encodeURIComponent(String(limit))}`,
    );
    return z.array(taskSummarySchema).parse(result);
  }

  async getTask(reference: string): Promise<TaskSummary> {
    return taskSummarySchema.parse(
      await this.request(
        'GET',
        `/api/v1/tasks/${encodeURIComponent(reference)}`,
      ),
    );
  }

  async events(
    input: {
      cursor?: number;
      taskId?: string;
      limit?: number;
    } = {},
  ): Promise<{ events: TaskEvent[]; nextCursor: number }> {
    const query = new URLSearchParams({
      cursor: String(input.cursor ?? 0),
      limit: String(input.limit ?? 100),
    });
    if (input.taskId) query.set('taskId', input.taskId);
    return eventPageSchema.parse(
      await this.request('GET', `/api/v1/events?${query.toString()}`),
    );
  }

  async *watch(
    input: {
      cursor?: number;
      taskId?: string;
      signal?: AbortSignal;
      pollMilliseconds?: number;
    } = {},
  ): AsyncGenerator<TaskEvent> {
    let cursor = input.cursor ?? 0;
    while (!input.signal?.aborted) {
      const page = await this.events({
        cursor,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      });
      for (const event of page.events) yield event;
      cursor = page.nextCursor;
      if (page.events.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, input.pollMilliseconds ?? 1_000);
          input.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }
  }

  async output(input: {
    taskId: string;
    cursor?: number;
    limit?: number;
  }): Promise<{ chunks: TaskOutputChunk[]; nextCursor: number }> {
    const query = new URLSearchParams({
      taskId: input.taskId,
      cursor: String(input.cursor ?? 0),
      limit: String(input.limit ?? 100),
    });
    return outputPageSchema.parse(
      await this.request('GET', `/api/v1/output?${query.toString()}`),
    );
  }

  async *watchOutput(input: {
    taskId: string;
    cursor?: number;
    signal?: AbortSignal;
    pollMilliseconds?: number;
  }): AsyncGenerator<TaskOutputChunk> {
    let cursor = input.cursor ?? 0;
    while (!input.signal?.aborted) {
      const page = await this.output({ taskId: input.taskId, cursor });
      for (const chunk of page.chunks) yield chunk;
      cursor = page.nextCursor;
      if (page.chunks.length === 0) {
        await abortableDelay(input.pollMilliseconds ?? 1_000, input.signal);
      }
    }
  }

  async registerWorker(
    input: WorkerRegistrationInput,
    idempotencyKey: string = randomUUID(),
  ): Promise<Worker> {
    return workerSchema.parse(
      await this.request(
        'POST',
        '/api/v1/workers',
        workerRegistrationSchema.parse(input),
        idempotencyKey,
      ),
    );
  }

  async claimWorkerTask(
    workerId: string,
    fencingToken: string,
    leaseMilliseconds = 60_000,
    idempotencyKey: string = randomUUID(),
  ): Promise<WorkerAssignment | null> {
    const result = await this.request(
      'POST',
      `/api/v1/workers/${encodeURIComponent(workerId)}/claim`,
      { fencingToken, leaseMilliseconds },
      idempotencyKey,
    );
    return result === null ? null : workerAssignmentSchema.parse(result);
  }

  async workspace(taskId: string): Promise<WorkspaceOwnership> {
    return workspaceOwnershipSchema.parse(
      await this.request(
        'GET',
        `/api/v1/tasks/${encodeURIComponent(taskId)}/workspace`,
      ),
    );
  }

  async rotateToken(): Promise<{
    token: string;
    actorId: string;
    role: string;
  }> {
    return tokenRotationResponseSchema.parse(
      await this.request('POST', '/api/v1/auth/token/rotate', {}),
    );
  }

  async revokeToken(): Promise<void> {
    await this.request('DELETE', '/api/v1/auth/token');
  }

  private async request(
    method: TransportRequest['method'],
    path: string,
    payload?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.options.token}`,
      'user-agent': '@praxrail/client/0.2.0',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey !== undefined) {
      headers['idempotency-key'] = idempotencyKey;
    }
    const retryableRequest = method === 'GET' || idempotencyKey !== undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.transport.request({
          method,
          path,
          headers,
          ...(body === undefined ? {} : { body }),
          timeoutMs: this.timeoutMs,
        });
        const parsed = response.body
          ? (JSON.parse(response.body) as unknown)
          : null;
        if (response.status >= 200 && response.status < 300) return parsed;
        const detail = apiErrorSchema.parse(parsed);
        if (retryableRequest && detail.retryable && attempt < this.maxRetries) {
          await abortableDelay(this.retryBaseDelayMs * 2 ** attempt);
          continue;
        }
        throw new PraxrailClientError(response.status, detail);
      } catch (error) {
        if (
          error instanceof PraxrailClientError ||
          !retryableRequest ||
          attempt >= this.maxRetries
        ) {
          throw error;
        }
        await abortableDelay(this.retryBaseDelayMs * 2 ** attempt);
      }
    }
  }
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
