import {
  API_VERSION,
  workerClaimSchema,
  workerHeartbeatSchema,
  workerRegistrationSchema,
  workspaceActionSchema,
  type ApiActor,
} from '@praxrail/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AuthenticationError,
  AuthorizationError,
  InvalidRequestError,
  RateLimitError,
} from '../domain/errors.js';
import type { Runtime } from '../runtime.js';
import { assertCapability } from '../security/permissions.js';

interface RateWindow {
  startedAt: number;
  count: number;
}

function assertRateLimit(
  windows: Map<string, RateWindow>,
  actor: ApiActor,
): void {
  const now = Date.now();
  const current = windows.get(actor.identityId);
  if (!current || now - current.startedAt >= 60_000) {
    windows.set(actor.identityId, { startedAt: now, count: 1 });
    if (windows.size > 10_000) {
      for (const [identityId, window] of windows) {
        if (now - window.startedAt >= 60_000) windows.delete(identityId);
      }
    }
    return;
  }
  if (current.count >= 600) throw new RateLimitError();
  current.count += 1;
}
const actors = new WeakMap<FastifyRequest, ApiActor>();
const referenceParams = z.object({ reference: z.string().min(1).max(200) });
const taskParams = z.object({ taskId: z.uuid() });
const workerParams = z.object({ workerId: z.uuid() });
const eventQuery = z.object({
  cursor: z.coerce.number().int().nonnegative().default(0),
  taskId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const outputQuery = z.object({
  cursor: z.coerce.number().int().nonnegative().default(0),
  taskId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const taskListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
const workerStatusBody = z.object({
  status: z.enum(['DRAINING', 'REVOKED']),
});
const pauseBody = z.object({
  workerId: z.uuid(),
  fencingToken: z.string().regex(/^\d+$/),
});
const returnBody = z.object({
  fencingToken: z.string().regex(/^\d+$/),
  reason: z.string().trim().min(5).max(1_000),
});
const resumeBody = z.object({
  workerId: z.uuid(),
  workerFencingToken: z.string().regex(/^\d+$/),
  leaseMilliseconds: z.number().int().min(5_000).max(300_000),
});
const recoverBody = workspaceActionSchema.extend({
  direction: z.enum(['HUMAN', 'AGENT']),
});
const bindBody = z.object({
  gitRefId: z.uuid(),
  workerId: z.uuid(),
  fencingToken: z.string().regex(/^\d+$/),
});

function bodyValue(request: FastifyRequest): unknown {
  if (Buffer.isBuffer(request.body)) {
    return JSON.parse(request.body.toString('utf8')) as unknown;
  }
  return request.body;
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) throw new AuthenticationError();
  return authorization.slice('Bearer '.length);
}

function actorFor(request: FastifyRequest): ApiActor {
  const actor = actors.get(request);
  if (!actor) throw new AuthenticationError();
  return actor;
}

async function assertTaskScope(
  runtime: Runtime,
  actor: ApiActor,
  reference: string,
): Promise<void> {
  if (
    actor.role === 'OPERATOR' ||
    (actor.role === 'OWNER' && actor.projectIds.length === 0)
  ) {
    return;
  }
  const result = await runtime.database.query<{ project_id: string | null }>(
    `SELECT project_id FROM tasks
     WHERE id::text = $1 OR upper(task_key) = upper($1)`,
    [reference],
  );
  const projectId = result.rows[0]?.project_id;
  if (!projectId || !actor.projectIds.includes(projectId)) {
    throw new AuthorizationError('Task is outside the actor project scope');
  }
}

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[a-zA-Z0-9._:-]{8,200}$/.test(key)) {
    throw new InvalidRequestError('A valid Idempotency-Key header is required');
  }
  return key;
}

async function idempotent<T>(input: {
  runtime: Runtime;
  request: FastifyRequest;
  actor: ApiActor;
  scope: string;
  body: unknown;
  operation: () => Promise<T>;
}): Promise<T> {
  const key = idempotencyKey(input.request);
  const scope = `${input.actor.identityId}:${input.scope}`;
  const started = await input.runtime.idempotency.begin(scope, key, input.body);
  if (!started.acquired) return started.response?.data as T;
  try {
    const result = await input.operation();
    await input.runtime.idempotency.complete(scope, key, {
      data: result,
    });
    return result;
  } catch (error) {
    await input.runtime.idempotency.fail(scope, key);
    throw error;
  }
}

export function registerProductApi(
  app: FastifyInstance,
  runtime: Runtime,
): void {
  if (!runtime.config.api.enabled) return;
  const rateWindows = new Map<string, RateWindow>();
  void app.register(
    (api, _options, done) => {
      api.addHook('preHandler', async (request) => {
        const actor = await runtime.auth.authenticate(bearerToken(request));
        assertRateLimit(rateWindows, actor);
        actors.set(request, actor);
      });

      api.get('/runtime', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'RUNTIME_READ');
        const database = await runtime.database.isReady();
        return {
          apiVersion: API_VERSION,
          runtimeVersion: '0.2.0',
          status: database && runtime.started ? 'READY' : 'DEGRADED',
          database,
          queue: runtime.started,
          mode: runtime.config.api.socketPath ? 'LOCAL' : 'REMOTE',
        };
      });

      api.post('/auth/token/rotate', async (request) => {
        const actor = actorFor(request);
        const token = await runtime.auth.rotate(actor);
        return { token, actorId: actor.actorId, role: actor.role };
      });
      api.delete('/auth/token', async (request, reply) => {
        await runtime.auth.revoke(actorFor(request));
        return reply.code(204).send();
      });

      api.get('/tasks', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_READ');
        const query = taskListQuery.parse(request.query);
        const tasks = await runtime.queries.active(query.limit);
        if (
          actor.role === 'OPERATOR' ||
          (actor.role === 'OWNER' && actor.projectIds.length === 0)
        )
          return tasks;
        const allowed = await runtime.database.query<{ id: string }>(
          `SELECT id FROM tasks WHERE id = ANY($1::uuid[])
             AND project_id = ANY($2::uuid[])`,
          [tasks.map((task) => task.id), actor.projectIds],
        );
        const ids = new Set(allowed.rows.map((row) => row.id));
        return tasks.filter((task) => ids.has(task.id));
      });
      api.get('/tasks/:reference', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_READ');
        const params = referenceParams.parse(request.params);
        await assertTaskScope(runtime, actor, params.reference);
        return runtime.queries.resolve(params.reference);
      });
      api.get('/events', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_READ');
        const query = eventQuery.parse(request.query);
        if (query.taskId) await assertTaskScope(runtime, actor, query.taskId);
        if (
          !query.taskId &&
          actor.role !== 'OPERATOR' &&
          actor.role !== 'OWNER'
        ) {
          throw new AuthorizationError(
            'Project-scoped event streams require taskId',
          );
        }
        return runtime.events.events({
          cursor: query.cursor,
          limit: query.limit,
          ...(query.taskId ? { taskId: query.taskId } : {}),
        });
      });

      api.get('/output', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_READ');
        const query = outputQuery.parse(request.query);
        await assertTaskScope(runtime, actor, query.taskId);
        return runtime.events.output(query);
      });

      api.post('/workers', async (request) => {
        const actor = actorFor(request);
        const body = workerRegistrationSchema.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: 'worker-register',
          body,
          operation: () => runtime.workers.register(body, actor),
        });
      });
      api.post('/workers/:workerId/heartbeat', async (request) => {
        const actor = actorFor(request);
        const params = workerParams.parse(request.params);
        const body = workerHeartbeatSchema.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: `worker-heartbeat:${params.workerId}`,
          body,
          operation: () =>
            runtime.workers.heartbeat({
              workerId: params.workerId,
              fencingToken: body.fencingToken,
              leaseMilliseconds: body.leaseMilliseconds,
              actor,
            }),
        });
      });
      api.post('/workers/:workerId/status', async (request) => {
        const actor = actorFor(request);
        const params = workerParams.parse(request.params);
        const body = workerStatusBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: `worker-status:${params.workerId}`,
          body,
          operation: async () => {
            await runtime.workers.setStatus(
              params.workerId,
              body.status,
              actor,
            );
            return { workerId: params.workerId, status: body.status };
          },
        });
      });
      api.post('/workers/:workerId/claim', async (request) => {
        const actor = actorFor(request);
        const params = workerParams.parse(request.params);
        const body = workerClaimSchema.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: `worker-claim:${params.workerId}`,
          body,
          operation: () =>
            runtime.workers.claim({
              workerId: params.workerId,
              fencingToken: body.fencingToken,
              leaseMilliseconds: body.leaseMilliseconds,
              actor,
              correlationId: request.id,
            }),
        });
      });

      api.get('/tasks/:taskId/workspace', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_READ');
        const params = taskParams.parse(request.params);
        await assertTaskScope(runtime, actor, params.taskId);
        return runtime.workspaces.get(params.taskId);
      });
      api.post('/tasks/:taskId/workspace/bind', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_BUILD_RESULT');
        const params = taskParams.parse(request.params);
        const body = bindBody.parse(bodyValue(request));
        await assertTaskScope(runtime, actor, params.taskId);
        return idempotent({
          runtime,
          request,
          actor,
          scope: `workspace-bind:${params.taskId}`,
          body,
          operation: () =>
            runtime.workspaces.bindGitRef({
              taskId: params.taskId,
              ...body,
              actor,
            }),
        });
      });
      api.post('/tasks/:taskId/workspace/attach', async (request) => {
        const actor = actorFor(request);
        const params = taskParams.parse(request.params);
        const body = workspaceActionSchema.parse(bodyValue(request));
        await assertTaskScope(runtime, actor, params.taskId);
        return idempotent({
          runtime,
          request,
          actor,
          scope: `workspace-attach:${params.taskId}`,
          body,
          operation: () =>
            runtime.workspaces.requestAttach({
              taskId: params.taskId,
              actor,
              reason: body.reason,
              leaseMilliseconds: body.leaseMilliseconds,
              correlationId: request.id,
            }),
        });
      });
      api.post('/tasks/:taskId/workspace/paused', async (request) => {
        const actor = actorFor(request);
        const params = taskParams.parse(request.params);
        const body = pauseBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: `workspace-paused:${params.taskId}`,
          body,
          operation: () =>
            runtime.workspaces.acknowledgeAgentPaused({
              taskId: params.taskId,
              actor,
              workerId: body.workerId,
              fencingToken: body.fencingToken,
              correlationId: request.id,
            }),
        });
      });
      api.post('/tasks/:taskId/workspace/return', async (request) => {
        const actor = actorFor(request);
        const params = taskParams.parse(request.params);
        const body = returnBody.parse(bodyValue(request));
        await assertTaskScope(runtime, actor, params.taskId);
        return idempotent({
          runtime,
          request,
          actor,
          scope: `workspace-return:${params.taskId}`,
          body,
          operation: () =>
            runtime.workspaces.returnToAgent({
              taskId: params.taskId,
              actor,
              fencingToken: body.fencingToken,
              reason: body.reason,
              correlationId: request.id,
            }),
        });
      });
      api.post('/tasks/:taskId/workspace/resume', async (request) => {
        const actor = actorFor(request);
        const params = taskParams.parse(request.params);
        const body = resumeBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: `workspace-resume:${params.taskId}`,
          body,
          operation: () =>
            runtime.workspaces.resumeAgent({
              taskId: params.taskId,
              actor,
              ...body,
              correlationId: request.id,
            }),
        });
      });
      api.post('/tasks/:taskId/workspace/recover', async (request) => {
        const actor = actorFor(request);
        const params = taskParams.parse(request.params);
        const body = recoverBody.parse(bodyValue(request));
        await assertTaskScope(runtime, actor, params.taskId);
        return idempotent({
          runtime,
          request,
          actor,
          scope: `workspace-recover:${params.taskId}`,
          body,
          operation: () =>
            runtime.workspaces.recover({
              taskId: params.taskId,
              actor,
              direction: body.direction,
              reason: body.reason,
              leaseMilliseconds: body.leaseMilliseconds,
              correlationId: request.id,
            }),
        });
      });
      done();
    },
    { prefix: '/api/v1' },
  );
}
