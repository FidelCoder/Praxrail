import { randomUUID } from 'node:crypto';
import {
  workerRegistrationSchema,
  type ApiActor,
  type Worker,
  type WorkerAssignment,
  type WorkerRegistration,
} from 'praxrail-core';
import type pg from 'pg';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
} from '../domain/errors.js';
import { assertTaskTransition } from '../domain/task-state.js';
import type { Database } from '../persistence/database.js';
import { assertCapability } from '../security/permissions.js';

interface WorkerRow {
  id: string;
  name: string;
  mode: 'EMBEDDED' | 'REMOTE';
  version: string;
  status: 'ACTIVE' | 'DRAINING' | 'OFFLINE' | 'REVOKED';
  profiles: string[];
  repository_ids: string[];
  capabilities: string[];
  fencing_token: string;
  lease_expires_at: Date;
}

interface ClaimRow {
  task_id: string;
  task_key: string;
  task_version: number;
  contract: Record<string, unknown>;
  repository_id: string;
  repository_full_name: string;
  worker_profile: string;
  current_attempt: number;
}

function mapWorker(row: WorkerRow): Worker {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    version: row.version,
    status: row.status,
    profiles: row.profiles,
    repositoryIds: row.repository_ids,
    capabilities: row.capabilities,
    fencingToken: row.fencing_token,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
  };
}

async function appendTaskEvent(
  client: pg.PoolClient,
  taskId: string,
  actorId: string,
  correlationId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO task_events
      (task_id, event_type, actor_type, actor_id, correlation_id, payload)
     VALUES ($1, 'TASK_CLAIMED', 'WORKER', $2, $3, $4)`,
    [taskId, actorId, correlationId, payload],
  );
}

export class WorkerRegistryService {
  constructor(private readonly database: Database) {}

  async register(input: WorkerRegistration, actor: ApiActor): Promise<Worker> {
    assertCapability(actor.role, 'WORKER_REGISTER');
    const parsed = workerRegistrationSchema.parse(input);
    await this.assertRepositoryScope(parsed.repositoryIds, actor);
    const expiresAt = new Date(Date.now() + parsed.leaseMilliseconds);
    const result = await this.database.query<WorkerRow>(
      `INSERT INTO workers
        (id, identity_id, name, mode, version, status, profiles,
         repository_ids, capabilities, fencing_token, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $8,
         nextval('fencing_token_sequence'), $9)
       ON CONFLICT (name) DO UPDATE SET
         identity_id = EXCLUDED.identity_id, mode = EXCLUDED.mode,
         version = EXCLUDED.version, status = 'ACTIVE',
         profiles = EXCLUDED.profiles, repository_ids = EXCLUDED.repository_ids,
         capabilities = EXCLUDED.capabilities,
         fencing_token = nextval('fencing_token_sequence'),
         lease_expires_at = EXCLUDED.lease_expires_at,
         heartbeat_at = now(), updated_at = now()
       WHERE workers.status <> 'REVOKED'
         AND (workers.identity_id = EXCLUDED.identity_id OR $10 = true)
       RETURNING id, name, mode, version, status, profiles, repository_ids,
         capabilities, fencing_token::text, lease_expires_at`,
      [
        randomUUID(),
        actor.identityId,
        parsed.name,
        parsed.mode,
        parsed.version,
        parsed.profiles,
        parsed.repositoryIds,
        JSON.stringify(parsed.capabilities),
        expiresAt,
        actor.role === 'OPERATOR',
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ConflictError(
        'Worker name is owned by another or revoked identity',
      );
    }
    return mapWorker(row);
  }

  async heartbeat(input: {
    workerId: string;
    fencingToken: string;
    leaseMilliseconds: number;
    actor: ApiActor;
  }): Promise<Worker> {
    assertCapability(input.actor.role, 'WORKER_HEARTBEAT');
    const expiresAt = new Date(Date.now() + input.leaseMilliseconds);
    const result = await this.database.query<WorkerRow>(
      `UPDATE workers SET lease_expires_at = $3, heartbeat_at = now(),
         status = CASE WHEN status = 'OFFLINE' THEN 'ACTIVE' ELSE status END,
         updated_at = now()
       WHERE id = $1 AND fencing_token = $2 AND status <> 'REVOKED'
         AND (identity_id = $4 OR $5 = true)
       RETURNING id, name, mode, version, status, profiles, repository_ids,
         capabilities, fencing_token::text, lease_expires_at`,
      [
        input.workerId,
        input.fencingToken,
        expiresAt,
        input.actor.identityId,
        input.actor.role === 'OPERATOR',
      ],
    );
    const row = result.rows[0];
    if (!row)
      throw new ConflictError('Worker heartbeat lost its fencing token');
    return mapWorker(row);
  }

  async setStatus(
    workerId: string,
    status: 'DRAINING' | 'REVOKED',
    actor: ApiActor,
  ): Promise<void> {
    if (actor.role !== 'OPERATOR') {
      throw new AuthorizationError('Only an operator may change worker status');
    }
    await this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE workers SET status = $2, updated_at = now()
         WHERE id = $1 AND status <> 'REVOKED'`,
        [workerId, status],
      );
      if (result.rowCount !== 1) {
        throw new NotFoundError('Worker was not found');
      }
      if (status === 'REVOKED') {
        await client.query(
          `UPDATE worker_assignments SET status = 'LOST', completed_at = now()
           WHERE worker_id = $1
             AND status IN ('CLAIMED', 'RUNNING', 'CANCELLING')`,
          [workerId],
        );
        await client.query(
          `UPDATE workspace_ownerships SET state = 'RECOVERY_REQUIRED',
             reason = 'Worker identity revoked', updated_at = now()
           WHERE worker_id = $1
             AND state IN ('AGENT_OWNED', 'PAUSING', 'RETURNING')`,
          [workerId],
        );
        await client.query(
          `UPDATE repository_locks SET expires_at = now(), heartbeat_at = now()
           WHERE worker_id = $1`,
          [workerId],
        );
      }
      await client.query(
        `INSERT INTO runtime_events
          (event_type, actor_type, actor_id, worker_id, correlation_id, payload)
         VALUES ('WORKER_STATUS_CHANGED', $2, $3, $1, $4, $5)`,
        [workerId, actor.role, actor.actorId, randomUUID(), { status }],
      );
    });
  }

  async claim(input: {
    workerId: string;
    fencingToken: string;
    leaseMilliseconds: number;
    actor: ApiActor;
    correlationId: string;
  }): Promise<WorkerAssignment | null> {
    assertCapability(input.actor.role, 'TASK_CLAIM');
    return this.database.transaction(async (client) => {
      const workers = await client.query<WorkerRow>(
        `SELECT id, name, mode, version, status, profiles, repository_ids,
                capabilities, fencing_token::text, lease_expires_at
         FROM workers WHERE id = $1
           AND (identity_id = $2 OR $3 = true) FOR UPDATE`,
        [
          input.workerId,
          input.actor.identityId,
          input.actor.role === 'OPERATOR',
        ],
      );
      const worker = workers.rows[0];
      if (
        worker?.status !== 'ACTIVE' ||
        worker.fencing_token !== input.fencingToken ||
        worker.lease_expires_at <= new Date()
      ) {
        throw new ConflictError('Worker is unavailable or fenced');
      }
      const candidates = await client.query<ClaimRow>(
        `SELECT task.id AS task_id, task.task_key, task.version AS task_version,
                task.contract, task.repository_id,
                repository.full_name AS repository_full_name,
                repository.worker_profile, task.current_attempt
         FROM tasks AS task
         JOIN repositories AS repository ON repository.id = task.repository_id
         WHERE task.status = 'READY' AND task.paused_at IS NULL
           AND repository.enabled = true
           AND repository.onboarding_status = 'APPROVED'
           AND repository.worker_profile = ANY($1::text[])
           AND repository.id = ANY($2::uuid[])
           AND NOT EXISTS (
             SELECT 1 FROM task_dependencies AS dependency
             JOIN tasks AS required ON required.id = dependency.dependency_task_id
             WHERE dependency.task_id = task.id
               AND required.status NOT IN ('MERGED', 'DEPLOYED', 'VERIFIED')
           )
           AND NOT EXISTS (
             SELECT 1 FROM repository_locks AS lock
             WHERE lock.repository_id = repository.id AND lock.expires_at > now()
           )
         ORDER BY task.priority DESC, task.created_at
         FOR UPDATE OF task SKIP LOCKED LIMIT 1`,
        [worker.profiles, worker.repository_ids],
      );
      const task = candidates.rows[0];
      if (!task) return null;
      assertTaskTransition({
        from: 'READY',
        to: 'BUILDING',
        actorRole: 'SCHEDULER',
        contract: task.contract,
      });
      const fence = await client.query<{ value: string }>(
        `SELECT nextval('fencing_token_sequence')::text AS value`,
      );
      const fencingToken = fence.rows[0]?.value;
      if (!fencingToken) throw new Error('Fencing sequence returned no value');
      const expiresAt = new Date(Date.now() + input.leaseMilliseconds);
      const lock = await client.query(
        `INSERT INTO repository_locks
          (repository_id, task_id, worker_id, fencing_token, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (repository_id) DO UPDATE SET
           task_id = EXCLUDED.task_id, worker_id = EXCLUDED.worker_id,
           fencing_token = EXCLUDED.fencing_token,
           expires_at = EXCLUDED.expires_at, heartbeat_at = now(), created_at = now()
         WHERE repository_locks.expires_at <= now()
         RETURNING repository_id`,
        [
          task.repository_id,
          task.task_id,
          input.workerId,
          fencingToken,
          expiresAt,
        ],
      );
      if (lock.rowCount !== 1) return null;
      const attemptId = randomUUID();
      const attemptNumber = task.current_attempt + 1;
      await client.query(
        `INSERT INTO task_attempts
          (id, task_id, attempt_number, status, worker_id, started_at)
         VALUES ($1, $2, $3, 'CLAIMED', $4, now())`,
        [attemptId, task.task_id, attemptNumber, input.workerId],
      );
      await client.query(
        `UPDATE tasks SET status = 'BUILDING', current_attempt = $2,
           version = version + 1, updated_at = now() WHERE id = $1`,
        [task.task_id, attemptNumber],
      );
      const assignmentId = randomUUID();
      await client.query(
        `INSERT INTO worker_assignments
          (id, worker_id, task_id, repository_id, attempt_id, status,
           fencing_token, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, 'CLAIMED', $6, $7)`,
        [
          assignmentId,
          input.workerId,
          task.task_id,
          task.repository_id,
          attemptId,
          fencingToken,
          expiresAt,
        ],
      );
      await client.query(
        `INSERT INTO workspace_ownerships
          (task_id, repository_id, assignment_id, state, worker_id,
           fencing_token, lease_expires_at)
         VALUES ($1, $2, $3, 'AGENT_OWNED', $4, $5, $6)
         ON CONFLICT (task_id) DO UPDATE SET
           assignment_id = EXCLUDED.assignment_id, state = 'AGENT_OWNED',
           owner_actor_id = NULL, requested_actor_id = NULL,
           worker_id = EXCLUDED.worker_id,
           fencing_token = EXCLUDED.fencing_token,
           lease_expires_at = EXCLUDED.lease_expires_at,
           reason = NULL, updated_at = now()`,
        [
          task.task_id,
          task.repository_id,
          assignmentId,
          input.workerId,
          fencingToken,
          expiresAt,
        ],
      );
      await appendTaskEvent(
        client,
        task.task_id,
        input.actor.actorId,
        input.correlationId,
        { assignmentId, workerId: input.workerId, fencingToken },
      );
      return {
        id: assignmentId,
        workerId: input.workerId,
        taskId: task.task_id,
        taskKey: task.task_key,
        repositoryId: task.repository_id,
        repositoryFullName: task.repository_full_name,
        workerProfile: task.worker_profile,
        attemptId,
        attemptNumber,
        fencingToken,
        leaseExpiresAt: expiresAt.toISOString(),
      };
    });
  }

  async recoverExpired(): Promise<{
    workers: number;
    assignments: number;
    workspaces: number;
  }> {
    return this.database.transaction(async (client) => {
      const workers = await client.query(
        `UPDATE workers SET status = 'OFFLINE', updated_at = now()
         WHERE status = 'ACTIVE' AND lease_expires_at <= now()`,
      );
      const assignments = await client.query(
        `UPDATE worker_assignments SET status = 'LOST', completed_at = now()
         WHERE status IN ('CLAIMED', 'RUNNING', 'CANCELLING')
           AND lease_expires_at <= now()`,
      );
      const workspaces = await client.query(
        `UPDATE workspace_ownerships AS ownership
         SET state = 'RECOVERY_REQUIRED', reason = 'Ownership lease expired',
             updated_at = now()
         WHERE ownership.state IN ('AGENT_OWNED', 'PAUSING', 'HUMAN_OWNED', 'RETURNING')
           AND ownership.lease_expires_at <= now()`,
      );
      return {
        workers: workers.rowCount ?? 0,
        assignments: assignments.rowCount ?? 0,
        workspaces: workspaces.rowCount ?? 0,
      };
    });
  }

  private async assertRepositoryScope(
    repositoryIds: string[],
    actor: ApiActor,
  ): Promise<void> {
    const result = await this.database.query<{ project_id: string }>(
      `SELECT project_id FROM repositories WHERE id = ANY($1::uuid[])`,
      [repositoryIds],
    );
    if (result.rowCount !== repositoryIds.length) {
      throw new NotFoundError('One or more worker repositories were not found');
    }
    if (
      actor.role !== 'OPERATOR' &&
      (actor.projectIds.length === 0 ||
        result.rows.some((row) => !actor.projectIds.includes(row.project_id)))
    ) {
      throw new ConflictError(
        'Worker repository is outside the actor project scope',
      );
    }
  }
}
