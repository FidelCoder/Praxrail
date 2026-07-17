import {
  apiErrorSchema,
  channelIdentitySchema,
  channelPreferenceSchema,
  diagnosticReportSchema,
  projectSchema,
  repositorySchema,
  runtimeStatusSchema,
  supportBundleSchema,
  taskDetailSchema,
  taskEvidenceSchema,
  taskEventSchema,
  taskOutputChunkSchema,
  taskSummarySchema,
  tokenRotationResponseSchema,
  workerAssignmentSchema,
  workerRegistrationSchema,
  workerSchema,
  workspaceOwnershipSchema,
  type ApiError,
  type ChannelIdentity,
  type ChannelPreference,
  type DiagnosticReport,
  type Project,
  type Repository,
  type RuntimeStatus,
  type SupportBundle,
  type TaskDetail,
  type TaskEvidence,
  type TaskEvent,
  type TaskOutputChunk,
  type TaskStatus,
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
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  retryBaseDelayMs?: number | undefined;
  allowInsecureRemote?: boolean | undefined;
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
      cursor?: number | undefined;
      taskId?: string | undefined;
      limit?: number | undefined;
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
      cursor?: number | undefined;
      taskId?: string | undefined;
      signal?: AbortSignal;
      pollMilliseconds?: number | undefined;
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
    cursor?: number | undefined;
    limit?: number | undefined;
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
    cursor?: number | undefined;
    signal?: AbortSignal;
    pollMilliseconds?: number | undefined;
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

  async listProjects(): Promise<Project[]> {
    return z
      .array(projectSchema)
      .parse(await this.request('GET', '/api/v1/projects'));
  }

  async getProject(reference: string): Promise<Project> {
    return projectSchema.parse(
      await this.request(
        'GET',
        `/api/v1/projects/${encodeURIComponent(reference)}`,
      ),
    );
  }

  async createProject(
    input: { slug: string; name: string; dryRun?: boolean | undefined },
    idempotencyKey: string = randomUUID(),
  ): Promise<Project & { dryRun?: boolean | undefined }> {
    return projectSchema
      .extend({ dryRun: z.boolean().optional() })
      .parse(
        await this.request('POST', '/api/v1/projects', input, idempotencyKey),
      );
  }

  async updateProject(
    reference: string,
    input: {
      name?: string | undefined;
      status?: Project['status'] | undefined;
      dryRun?: boolean | undefined;
    },
    idempotencyKey: string = randomUUID(),
  ): Promise<Project & { dryRun?: boolean | undefined }> {
    return projectSchema
      .extend({ dryRun: z.boolean().optional() })
      .parse(
        await this.request(
          'PATCH',
          `/api/v1/projects/${encodeURIComponent(reference)}`,
          input,
          idempotencyKey,
        ),
      );
  }

  async listRepositories(projectId?: string): Promise<Repository[]> {
    const query = projectId
      ? `?projectId=${encodeURIComponent(projectId)}`
      : '';
    return z
      .array(repositorySchema)
      .parse(await this.request('GET', `/api/v1/repositories${query}`));
  }

  async getRepository(reference: string): Promise<Repository> {
    return repositorySchema.parse(
      await this.request(
        'GET',
        `/api/v1/repositories/${encodeURIComponent(reference)}`,
      ),
    );
  }

  async addRepository(
    input: {
      projectId: string;
      fullName: string;
      cloneUrl: string;
      defaultBranch: string;
      workerProfile: string;
      githubRepositoryId?: number | undefined;
      githubInstallationId?: number | undefined;
      mirrorPath?: string | undefined;
      verificationCommands?: string[];
      policy?: Record<string, unknown>;
      dryRun?: boolean | undefined;
    },
    idempotencyKey: string = randomUUID(),
  ): Promise<Repository & { dryRun?: boolean | undefined }> {
    return repositorySchema
      .extend({ dryRun: z.boolean().optional() })
      .parse(
        await this.request(
          'POST',
          '/api/v1/repositories',
          input,
          idempotencyKey,
        ),
      );
  }

  async inspectRepository(reference: string): Promise<Record<string, unknown>> {
    return z
      .record(z.string(), z.unknown())
      .parse(
        await this.request(
          'GET',
          `/api/v1/repositories/${encodeURIComponent(reference)}/inspection`,
        ),
      );
  }

  async setRepositoryStatus(
    reference: string,
    input: {
      action: 'approve' | 'disable' | 'remove';
      dryRun?: boolean | undefined;
    },
    idempotencyKey: string = randomUUID(),
  ): Promise<Record<string, unknown>> {
    return z
      .record(z.string(), z.unknown())
      .parse(
        await this.request(
          'POST',
          `/api/v1/repositories/${encodeURIComponent(reference)}/status`,
          input,
          idempotencyKey,
        ),
      );
  }

  async listTaskDetails(
    input: {
      projectId?: string | undefined;
      repositoryId?: string | undefined;
      status?: TaskStatus | undefined;
      limit?: number | undefined;
      includeArchived?: boolean | undefined;
    } = {},
  ): Promise<TaskDetail[]> {
    const query = new URLSearchParams();
    if (input.projectId) query.set('projectId', input.projectId);
    if (input.repositoryId) query.set('repositoryId', input.repositoryId);
    if (input.status) query.set('status', input.status);
    if (input.limit) query.set('limit', String(input.limit));
    if (input.includeArchived) query.set('includeArchived', 'true');
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return z
      .array(taskDetailSchema)
      .parse(await this.request('GET', `/api/v1/task-details${suffix}`));
  }

  async getTaskDetail(reference: string): Promise<TaskDetail> {
    return taskDetailSchema.parse(
      await this.request(
        'GET',
        `/api/v1/task-details/${encodeURIComponent(reference)}`,
      ),
    );
  }

  async createTask(
    input: {
      title: string;
      request: string;
      projectId: string;
      repositoryId: string;
      priority?: number | undefined;
      budgetUsd?: number | undefined;
      dryRun?: boolean | undefined;
    },
    idempotencyKey: string = randomUUID(),
  ): Promise<TaskDetail & { dryRun?: boolean | undefined }> {
    return taskDetailSchema
      .extend({ dryRun: z.boolean().optional() })
      .parse(
        await this.request(
          'POST',
          '/api/v1/task-details',
          input,
          idempotencyKey,
        ),
      );
  }

  async controlTask(
    reference: string,
    input: {
      action:
        | 'clarify'
        | 'prioritize'
        | 'pause'
        | 'resume'
        | 'cancel'
        | 'retry'
        | 'abandon'
        | 'archive';
      reason?: string | undefined;
      priority?: number | undefined;
    },
    idempotencyKey: string = randomUUID(),
  ): Promise<TaskDetail> {
    return taskDetailSchema.parse(
      await this.request(
        'POST',
        `/api/v1/task-details/${encodeURIComponent(reference)}/control`,
        input,
        idempotencyKey,
      ),
    );
  }

  async taskEvidence(reference: string): Promise<TaskEvidence> {
    return taskEvidenceSchema.parse(
      await this.request(
        'GET',
        `/api/v1/task-details/${encodeURIComponent(reference)}/evidence`,
      ),
    );
  }

  async requestPipelineAction(
    reference: string,
    action: 'check' | 'review' | 'fix' | 'publish',
    reason: string,
    idempotencyKey: string = randomUUID(),
  ): Promise<Record<string, unknown>> {
    return z
      .record(z.string(), z.unknown())
      .parse(
        await this.request(
          'POST',
          `/api/v1/task-details/${encodeURIComponent(reference)}/pipeline/${action}`,
          { reason },
          idempotencyKey,
        ),
      );
  }

  async workspaceContext(taskId: string): Promise<Record<string, unknown>> {
    return z
      .record(z.string(), z.unknown())
      .parse(
        await this.request(
          'GET',
          `/api/v1/tasks/${encodeURIComponent(taskId)}/workspace/context`,
        ),
      );
  }

  async requestWorkspaceAttach(
    taskId: string,
    reason: string,
    leaseMilliseconds = 3_600_000,
    idempotencyKey: string = randomUUID(),
  ): Promise<WorkspaceOwnership> {
    return workspaceOwnershipSchema.parse(
      await this.request(
        'POST',
        `/api/v1/tasks/${encodeURIComponent(taskId)}/workspace/attach`,
        { reason, leaseMilliseconds },
        idempotencyKey,
      ),
    );
  }

  async returnWorkspace(
    taskId: string,
    fencingToken: string,
    reason: string,
    idempotencyKey: string = randomUUID(),
  ): Promise<Record<string, unknown>> {
    return z
      .record(z.string(), z.unknown())
      .parse(
        await this.request(
          'POST',
          `/api/v1/tasks/${encodeURIComponent(taskId)}/workspace/return`,
          { fencingToken, reason },
          idempotencyKey,
        ),
      );
  }

  async recoverWorkspace(
    taskId: string,
    direction: 'HUMAN' | 'AGENT',
    reason: string,
    leaseMilliseconds = 3_600_000,
    idempotencyKey: string = randomUUID(),
  ): Promise<WorkspaceOwnership> {
    return workspaceOwnershipSchema.parse(
      await this.request(
        'POST',
        `/api/v1/tasks/${encodeURIComponent(taskId)}/workspace/recover`,
        { direction, reason, leaseMilliseconds },
        idempotencyKey,
      ),
    );
  }

  async listChannels(): Promise<ChannelIdentity[]> {
    return z
      .array(channelIdentitySchema)
      .parse(await this.request('GET', '/api/v1/channels'));
  }

  async linkChannel(
    input: {
      channel: 'EMAIL' | 'TELEGRAM';
      destination: string;
      projectId?: string | undefined;
    },
    idempotencyKey: string = randomUUID(),
  ): Promise<{ identity: ChannelIdentity; verificationQueued: true }> {
    return z
      .object({
        identity: channelIdentitySchema,
        verificationQueued: z.literal(true),
      })
      .parse(
        await this.request(
          'POST',
          '/api/v1/channels/link',
          input,
          idempotencyKey,
        ),
      );
  }

  async verifyChannel(
    identityId: string,
    code: string,
    idempotencyKey: string = randomUUID(),
  ): Promise<ChannelIdentity> {
    return channelIdentitySchema.parse(
      await this.request(
        'POST',
        `/api/v1/channels/${encodeURIComponent(identityId)}/verify`,
        { code },
        idempotencyKey,
      ),
    );
  }

  async setChannelStatus(
    identityId: string,
    status: 'VERIFIED' | 'DISABLED' | 'REVOKED',
    idempotencyKey: string = randomUUID(),
  ): Promise<ChannelIdentity> {
    return channelIdentitySchema.parse(
      await this.request(
        'POST',
        `/api/v1/channels/${encodeURIComponent(identityId)}/status`,
        { status },
        idempotencyKey,
      ),
    );
  }

  async setChannelPreference(
    preference: ChannelPreference,
    idempotencyKey: string = randomUUID(),
  ): Promise<ChannelPreference> {
    return channelPreferenceSchema.parse(
      await this.request(
        'PUT',
        '/api/v1/channel-preferences',
        preference,
        idempotencyKey,
      ),
    );
  }

  async configureConnector(
    channel: 'EMAIL' | 'TELEGRAM',
    input: {
      enabled: boolean;
      credentialReference?: string | undefined;
      configuration?: Record<string, unknown>;
    },
    idempotencyKey: string = randomUUID(),
  ): Promise<Record<string, unknown>> {
    return z
      .record(z.string(), z.unknown())
      .parse(
        await this.request(
          'PUT',
          `/api/v1/connectors/${channel}`,
          input,
          idempotencyKey,
        ),
      );
  }

  async listConnectors(): Promise<Record<string, unknown>[]> {
    return z
      .array(z.record(z.string(), z.unknown()))
      .parse(await this.request('GET', '/api/v1/connectors'));
  }

  async connectorStatus(
    channel: 'EMAIL' | 'TELEGRAM',
  ): Promise<Record<string, unknown>> {
    return z
      .record(z.string(), z.unknown())
      .parse(await this.request('GET', `/api/v1/connectors/${channel}`));
  }

  async testConnector(
    channel: 'EMAIL' | 'TELEGRAM',
    idempotencyKey: string = randomUUID(),
  ): Promise<Record<string, unknown>> {
    return z
      .record(z.string(), z.unknown())
      .parse(
        await this.request(
          'POST',
          `/api/v1/connectors/${channel}/test`,
          {},
          idempotencyKey,
        ),
      );
  }

  async decideApproval(
    approvalId: string,
    input: { token: string; approved: boolean; reason: string },
    idempotencyKey: string = randomUUID(),
  ): Promise<Record<string, unknown>> {
    return z
      .record(z.string(), z.unknown())
      .parse(
        await this.request(
          'POST',
          `/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
          input,
          idempotencyKey,
        ),
      );
  }

  async doctor(): Promise<DiagnosticReport> {
    return diagnosticReportSchema.parse(
      await this.request('GET', '/api/v1/diagnostics'),
    );
  }

  async supportBundle(): Promise<SupportBundle> {
    return supportBundleSchema.parse(
      await this.request('GET', '/api/v1/support-bundle'),
    );
  }

  async upgradePreflight(): Promise<{
    compatible: boolean;
    blockers: string[];
    steps: string[];
  }> {
    return z
      .object({
        compatible: z.boolean(),
        blockers: z.array(z.string()),
        steps: z.array(z.string()),
      })
      .parse(await this.request('GET', '/api/v1/upgrade/preflight'));
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
      'user-agent': '@praxrail/client/0.3.0',
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
