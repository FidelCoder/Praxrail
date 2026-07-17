import {
  API_VERSION,
  channelPreferenceSchema,
  channelSchema,
  workerClaimSchema,
  workerHeartbeatSchema,
  workerRegistrationSchema,
  workspaceActionSchema,
  type ApiActor,
} from 'praxrail-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
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
const productReferenceParams = z.object({
  reference: z.string().min(1).max(200),
});
const actionParams = productReferenceParams.extend({
  action: z.enum(['check', 'review', 'fix', 'publish']),
});
const projectCreateBody = z.object({
  slug: z.string().min(2).max(63),
  name: z.string().min(2).max(120),
  dryRun: z.boolean().default(false),
});
const projectUpdateBody = z.object({
  name: z.string().min(2).max(120).optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'DISABLED']).optional(),
  dryRun: z.boolean().default(false),
});
const repositoryListQuery = z.object({ projectId: z.uuid().optional() });
const repositoryCreateBody = z.object({
  projectId: z.uuid(),
  fullName: z.string().min(3).max(300),
  cloneUrl: z.url(),
  defaultBranch: z.string().min(1).max(200),
  workerProfile: z.string().min(1).max(100),
  githubRepositoryId: z.number().int().positive().optional(),
  githubInstallationId: z.number().int().positive().optional(),
  mirrorPath: z.string().min(1).max(2_000).optional(),
  verificationCommands: z.array(z.string().min(1).max(200)).max(100).optional(),
  policy: z.record(z.string(), z.unknown()).optional(),
  dryRun: z.boolean().default(false),
});
const repositoryActionBody = z.object({
  action: z.enum(['approve', 'disable', 'remove']),
  dryRun: z.boolean().default(false),
});
const productTaskListQuery = z.object({
  projectId: z.uuid().optional(),
  repositoryId: z.uuid().optional(),
  status: z
    .enum([
      'INBOX',
      'REFINING',
      'BLOCKED',
      'READY',
      'BUILDING',
      'FAILED',
      'REVIEWING',
      'CHANGES_REQUESTED',
      'CI',
      'PR_READY',
      'AWAITING_APPROVAL',
      'MERGED',
      'DEPLOYED',
      'VERIFIED',
      'CANCELLED',
      'ABANDONED',
      'SUPERSEDED',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  includeArchived: z.coerce.boolean().default(false),
});
const taskCreateBody = z.object({
  title: z.string().min(1).max(180),
  request: z.string().min(1).max(10_000),
  projectId: z.uuid(),
  repositoryId: z.uuid(),
  priority: z.number().int().min(0).max(100).optional(),
  budgetUsd: z.number().positive().optional(),
  dryRun: z.boolean().default(false),
});
const taskControlBody = z.object({
  action: z.enum([
    'clarify',
    'prioritize',
    'pause',
    'resume',
    'cancel',
    'retry',
    'abandon',
    'archive',
  ]),
  reason: z.string().min(1).max(10_000).optional(),
  priority: z.number().int().min(0).max(100).optional(),
});
const pipelineBody = z.object({
  reason: z.string().min(1).max(1_000),
});
const channelLinkBody = z.object({
  channel: channelSchema,
  destination: z.string().min(1).max(500),
  projectId: z.uuid().optional(),
});
const channelVerifyBody = z.object({ code: z.string().min(16).max(200) });
const channelStatusBody = z.object({
  status: z.enum(['VERIFIED', 'DISABLED', 'REVOKED']),
});
const connectorParams = z.object({ channel: channelSchema });
const connectorBody = z.object({
  enabled: z.boolean(),
  credentialReference: z.string().min(1).max(2_000).optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
});
const approvalParams = z.object({ approvalId: z.uuid() });
const approvalDecisionBody = z.object({
  token: z.string().min(16).max(500),
  approved: z.boolean(),
  reason: z.string().min(1).max(1_000),
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
          runtimeVersion: '0.3.0',
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
      api.get('/projects', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_READ');
        return runtime.product.listProjects(actor);
      });
      api.post('/projects', async (request) => {
        const actor = actorFor(request);
        const body = projectCreateBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: 'project-create',
          body,
          operation: () => runtime.product.createProject(body, actor),
        });
      });
      api.get('/projects/:reference', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_READ');
        const params = productReferenceParams.parse(request.params);
        return runtime.product.getProject(params.reference, actor);
      });
      api.patch('/projects/:reference', async (request) => {
        const actor = actorFor(request);
        const params = productReferenceParams.parse(request.params);
        const body = projectUpdateBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: `project-update:${params.reference}`,
          body,
          operation: () =>
            runtime.product.updateProject(params.reference, body, actor),
        });
      });

      api.get('/repositories', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_READ');
        const query = repositoryListQuery.parse(request.query);
        return runtime.product.listRepositories(actor, query.projectId);
      });
      api.post('/repositories', async (request) => {
        const actor = actorFor(request);
        const body = repositoryCreateBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: 'repository-create',
          body,
          operation: () => runtime.product.addRepository(body, actor),
        });
      });
      api.get('/repositories/:reference', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_READ');
        const params = productReferenceParams.parse(request.params);
        return runtime.product.getRepository(params.reference, actor);
      });
      api.get('/repositories/:reference/inspection', async (request) => {
        const actor = actorFor(request);
        const params = productReferenceParams.parse(request.params);
        return runtime.product.inspectRepository(params.reference, actor);
      });
      api.post('/repositories/:reference/status', async (request) => {
        const actor = actorFor(request);
        const params = productReferenceParams.parse(request.params);
        const body = repositoryActionBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: `repository-status:${params.reference}`,
          body,
          operation: () =>
            runtime.product.setRepositoryStatus(
              params.reference,
              body.action,
              actor,
              body.dryRun,
            ),
        });
      });

      api.get('/task-details', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_READ');
        const query = productTaskListQuery.parse(request.query);
        return runtime.product.listTasks(actor, query);
      });
      api.post('/task-details', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_CREATE');
        const body = taskCreateBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: 'task-create',
          body,
          operation: () => runtime.product.createTask(body, actor),
        });
      });
      api.get('/task-details/:reference', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_READ');
        const params = productReferenceParams.parse(request.params);
        return runtime.product.getTask(params.reference, actor);
      });
      api.post('/task-details/:reference/control', async (request) => {
        const actor = actorFor(request);
        const params = productReferenceParams.parse(request.params);
        const body = taskControlBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: `task-control:${params.reference}`,
          body,
          operation: () =>
            runtime.product.controlTask(
              params.reference,
              body,
              actor,
              request.id,
            ),
        });
      });
      api.get('/task-details/:reference/evidence', async (request) => {
        const actor = actorFor(request);
        assertCapability(actor.role, 'TASK_READ');
        const params = productReferenceParams.parse(request.params);
        return runtime.product.taskEvidence(params.reference, actor);
      });
      api.post('/task-details/:reference/pipeline/:action', async (request) => {
        const actor = actorFor(request);
        const params = actionParams.parse(request.params);
        const body = pipelineBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: `pipeline:${params.reference}:${params.action}`,
          body,
          operation: () =>
            runtime.product.requestPipelineAction(
              params.reference,
              params.action,
              actor,
              body.reason,
            ),
        });
      });

      api.get('/channels', async (request) => {
        return runtime.product.listChannels(actorFor(request));
      });
      api.post('/channels/link', async (request) => {
        const actor = actorFor(request);
        const body = channelLinkBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: 'channel-link',
          body,
          operation: () => runtime.product.linkChannel(body, actor),
        });
      });
      api.post('/channels/:reference/verify', async (request) => {
        const actor = actorFor(request);
        const params = productReferenceParams.parse(request.params);
        const body = channelVerifyBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: `channel-verify:${params.reference}`,
          body,
          operation: () =>
            runtime.product.verifyChannel(params.reference, body.code, actor),
        });
      });
      api.post('/channels/:reference/status', async (request) => {
        const actor = actorFor(request);
        const params = productReferenceParams.parse(request.params);
        const body = channelStatusBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: `channel-status:${params.reference}`,
          body,
          operation: () =>
            runtime.product.setChannelStatus(
              params.reference,
              body.status,
              actor,
            ),
        });
      });
      api.put('/channel-preferences', async (request) => {
        const actor = actorFor(request);
        const body = channelPreferenceSchema.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: 'channel-preference',
          body,
          operation: () => runtime.product.setChannelPreference(body, actor),
        });
      });
      api.put('/connectors/:channel', async (request) => {
        const actor = actorFor(request);
        const params = connectorParams.parse(request.params);
        const body = connectorBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: `connector:${params.channel}`,
          body,
          operation: () =>
            runtime.product.configureConnector(params.channel, body, actor),
        });
      });
      api.get('/connectors', async (request) => {
        return runtime.product.listConnectors(actorFor(request));
      });
      api.get('/connectors/:channel', async (request) => {
        const params = connectorParams.parse(request.params);
        return runtime.product.getConnector(params.channel, actorFor(request));
      });
      api.post('/connectors/:channel/test', async (request) => {
        const actor = actorFor(request);
        const params = connectorParams.parse(request.params);
        return idempotent({
          runtime,
          request,
          actor,
          scope: `connector-test:${params.channel}`,
          body: {},
          operation: () => runtime.product.testConnector(params.channel, actor),
        });
      });
      api.post('/approvals/:approvalId/decision', async (request) => {
        const actor = actorFor(request);
        const params = approvalParams.parse(request.params);
        const body = approvalDecisionBody.parse(bodyValue(request));
        return idempotent({
          runtime,
          request,
          actor,
          scope: `approval:${params.approvalId}`,
          body,
          operation: async () => {
            await runtime.approvals.decide({
              approvalId: params.approvalId,
              actorId: actor.actorId,
              token: body.token,
              approved: body.approved,
              reason: body.reason,
            });
            return {
              approvalId: params.approvalId,
              status: body.approved ? 'APPROVED' : 'REJECTED',
            };
          },
        });
      });
      api.get('/diagnostics', async (request) => {
        assertCapability(actorFor(request).role, 'RUNTIME_READ');
        return runtime.product.doctor();
      });
      api.get('/support-bundle', async (request) => {
        assertCapability(actorFor(request).role, 'RUNTIME_READ');
        return runtime.product.supportBundle();
      });
      api.get('/upgrade/preflight', async (request) => {
        const actor = actorFor(request);
        if (actor.role !== 'OPERATOR') {
          throw new AuthorizationError('Operator authority is required');
        }
        return runtime.product.upgradePreflight();
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
      api.get('/tasks/:taskId/workspace/context', async (request) => {
        const actor = actorFor(request);
        const params = taskParams.parse(request.params);
        if (!runtime.config.api.socketPath) {
          throw new ConflictError(
            'Interactive shell requires a local Unix-socket runtime',
          );
        }
        return runtime.product.workspaceContext(params.taskId, actor);
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
