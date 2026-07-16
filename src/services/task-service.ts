import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import { assertTaskTransition, type TaskStatus } from '../domain/task-state.js';
import {
  taskContractSchema,
  type TaskContract,
  type TaskProposal,
} from '../domain/task-contract.js';
import type { ActorRole } from '../security/permissions.js';
import { assertCapability } from '../security/permissions.js';
import type { Database } from '../persistence/database.js';

export interface TaskRecord {
  id: string;
  taskKey: string;
  title: string;
  problem: string;
  desiredOutcome: string;
  status: TaskStatus;
  priority: number;
  contract: TaskContract | null;
  version: number;
  pausedAt: Date | null;
  blockedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TaskRow {
  id: string;
  task_key: string;
  title: string;
  problem: string;
  desired_outcome: string;
  status: TaskStatus;
  priority: number;
  contract: unknown;
  version: number;
  paused_at: Date | null;
  blocked_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  task_id: string | null;
}

export interface CreateInboxTaskInput {
  provider: 'TELEGRAM' | 'EMAIL' | 'GITHUB';
  externalMessageId: string;
  senderId: string;
  chatOrThreadId?: string;
  authenticated: boolean;
  envelope: Record<string, unknown>;
  messageText: string;
  title: string;
  actorType: string;
  actorId: string;
  correlationId?: string;
}

export interface TransitionTaskInput {
  taskId: string;
  expectedStatus: TaskStatus;
  expectedVersion: number;
  to: TaskStatus;
  actorRole: ActorRole;
  actorId: string;
  correlationId: string;
  contract?: TaskContract | null;
  blockedReason?: string | null;
  eventPayload?: Record<string, unknown>;
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    taskKey: row.task_key,
    title: row.title,
    problem: row.problem,
    desiredOutcome: row.desired_outcome,
    status: row.status,
    priority: row.priority,
    contract: row.contract ? taskContractSchema.parse(row.contract) : null,
    version: row.version,
    pausedAt: row.paused_at,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function selectTask(
  client: pg.PoolClient,
  id: string,
  forUpdate = false,
): Promise<TaskRow> {
  const result = await client.query<TaskRow>(
    `SELECT id, task_key, title, problem, desired_outcome, status, priority,
            contract, version, paused_at, blocked_reason, created_at, updated_at
       FROM tasks WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const task = result.rows[0];
  if (!task) throw new NotFoundError(`Task ${id} was not found`);
  return task;
}

async function appendEvent(
  client: pg.PoolClient,
  taskId: string,
  eventType: string,
  actorType: string,
  actorId: string,
  correlationId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO task_events
       (task_id, event_type, actor_type, actor_id, correlation_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [taskId, eventType, actorType, actorId, correlationId, payload],
  );
}

export class TaskService {
  constructor(private readonly database: Database) {}

  async createInboxTask(
    input: CreateInboxTaskInput,
  ): Promise<{ task: TaskRecord; replayed: boolean }> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<MessageRow>(
        `SELECT id, task_id FROM incoming_messages
         WHERE provider = $1 AND external_id = $2`,
        [input.provider, input.externalMessageId],
      );
      const prior = existing.rows[0];
      if (prior?.task_id) {
        return {
          task: mapTask(await selectTask(client, prior.task_id)),
          replayed: true,
        };
      }
      if (prior) throw new ConflictError('Message is already being processed');

      const correlationId = input.correlationId ?? randomUUID();
      const messageId = randomUUID();
      const bodyDigest = createHash('sha256')
        .update(input.messageText, 'utf8')
        .digest('hex');
      await client.query(
        `INSERT INTO incoming_messages
          (id, provider, external_id, sender_id, chat_or_thread_id, correlation_id,
           authenticated, envelope, body_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          messageId,
          input.provider,
          input.externalMessageId,
          input.senderId,
          input.chatOrThreadId ?? null,
          correlationId,
          input.authenticated,
          input.envelope,
          bodyDigest,
        ],
      );

      const sequenceResult = await client.query<{ value: string }>(
        "SELECT nextval('task_key_sequence')::text AS value",
      );
      const sequence = sequenceResult.rows[0]?.value;
      if (!sequence) throw new Error('Task key sequence returned no value');

      const taskId = randomUUID();
      const taskKey = `PXR-${sequence.padStart(4, '0')}`;
      const taskResult = await client.query<TaskRow>(
        `INSERT INTO tasks
          (id, task_key, title, status, created_by_type, created_by_id)
         VALUES ($1, $2, $3, 'INBOX', $4, $5)
         RETURNING id, task_key, title, problem, desired_outcome, status, priority,
                   contract, version, paused_at, blocked_reason, created_at, updated_at`,
        [taskId, taskKey, input.title, input.actorType, input.actorId],
      );
      await client.query(
        'UPDATE incoming_messages SET task_id = $1, processed_at = now() WHERE id = $2',
        [taskId, messageId],
      );
      await appendEvent(
        client,
        taskId,
        'TASK_CREATED',
        input.actorType,
        input.actorId,
        correlationId,
        {
          provider: input.provider,
          messageId,
        },
      );

      const task = taskResult.rows[0];
      if (!task) throw new Error('Task insert returned no record');
      return { task: mapTask(task), replayed: false };
    });
  }

  async getTask(id: string): Promise<TaskRecord> {
    const result = await this.database.query<TaskRow>(
      `SELECT id, task_key, title, problem, desired_outcome, status, priority,
              contract, version, paused_at, blocked_reason, created_at, updated_at
       FROM tasks WHERE id = $1`,
      [id],
    );
    const task = result.rows[0];
    if (!task) throw new NotFoundError(`Task ${id} was not found`);
    return mapTask(task);
  }

  async addDependency(
    taskId: string,
    dependencyTaskId: string,
    actorRole: ActorRole,
    actorId: string,
    correlationId: string,
  ): Promise<boolean> {
    assertCapability(actorRole, 'TASK_REFINE');
    if (taskId === dependencyTaskId) {
      throw new ConflictError('A task cannot depend on itself');
    }
    return this.database.transaction(async (client) => {
      const locked = await client.query<{ id: string }>(
        `SELECT id FROM tasks WHERE id = ANY($1::uuid[])
         ORDER BY id FOR UPDATE`,
        [[taskId, dependencyTaskId]],
      );
      if (locked.rowCount !== 2) {
        throw new NotFoundError('Task or dependency was not found');
      }
      const cycle = await client.query<{ present: boolean }>(
        `WITH RECURSIVE dependencies(id) AS (
           SELECT dependency_task_id FROM task_dependencies WHERE task_id = $2
           UNION
           SELECT edge.dependency_task_id
           FROM task_dependencies AS edge
           JOIN dependencies ON edge.task_id = dependencies.id
         )
         SELECT EXISTS(SELECT 1 FROM dependencies WHERE id = $1) AS present`,
        [taskId, dependencyTaskId],
      );
      if (cycle.rows[0]?.present) {
        throw new ConflictError('Task dependency would create a cycle');
      }
      const inserted = await client.query(
        `INSERT INTO task_dependencies (task_id, dependency_task_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [taskId, dependencyTaskId],
      );
      if (inserted.rowCount !== 1) return false;
      await appendEvent(
        client,
        taskId,
        'TASK_DEPENDENCY_ADDED',
        actorRole,
        actorId,
        correlationId,
        { dependencyTaskId },
      );
      return true;
    });
  }

  async removeDependency(
    taskId: string,
    dependencyTaskId: string,
    actorRole: ActorRole,
    actorId: string,
    correlationId: string,
  ): Promise<boolean> {
    assertCapability(actorRole, 'TASK_REFINE');
    return this.database.transaction(async (client) => {
      await selectTask(client, taskId, true);
      const removed = await client.query(
        `DELETE FROM task_dependencies
         WHERE task_id = $1 AND dependency_task_id = $2`,
        [taskId, dependencyTaskId],
      );
      if (removed.rowCount !== 1) return false;
      await appendEvent(
        client,
        taskId,
        'TASK_DEPENDENCY_REMOVED',
        actorRole,
        actorId,
        correlationId,
        { dependencyTaskId },
      );
      return true;
    });
  }

  async transition(input: TransitionTaskInput): Promise<TaskRecord> {
    return this.database.transaction(async (client) => {
      const row = await selectTask(client, input.taskId, true);
      if (
        row.status !== input.expectedStatus ||
        row.version !== input.expectedVersion
      ) {
        throw new ConflictError(
          `Task changed; expected ${input.expectedStatus} v${input.expectedVersion}, got ${row.status} v${row.version}`,
        );
      }

      assertTaskTransition({
        from: row.status,
        to: input.to,
        actorRole: input.actorRole,
        contract:
          input.contract ??
          (row.contract as TaskContract | Record<string, unknown> | null),
      });

      const contract = input.contract ?? (row.contract as TaskContract | null);
      const parsedContract = contract
        ? taskContractSchema.parse(contract)
        : null;
      const result = await client.query<TaskRow>(
        `UPDATE tasks SET
           status = $2, contract = $3, contract_version = $4,
           project_id = COALESCE($5, project_id),
           repository_id = COALESCE($6, repository_id),
           risk = COALESCE($7, risk), budget_usd = COALESCE($8, budget_usd),
           maximum_attempts = COALESCE($9, maximum_attempts),
           blocked_reason = $10, version = version + 1, updated_at = now(),
           completed_at = CASE WHEN $2 IN ('VERIFIED', 'CANCELLED', 'ABANDONED', 'SUPERSEDED') THEN now() ELSE completed_at END
         WHERE id = $1
         RETURNING id, task_key, title, problem, desired_outcome, status, priority,
                   contract, version, paused_at, blocked_reason, created_at, updated_at`,
        [
          input.taskId,
          input.to,
          parsedContract,
          parsedContract?.version ?? null,
          parsedContract?.projectId ?? null,
          parsedContract?.repositoryId ?? null,
          parsedContract?.risk ?? null,
          parsedContract?.budgetUsd ?? null,
          parsedContract?.maximumAttempts ?? null,
          input.blockedReason ?? null,
        ],
      );
      await appendEvent(
        client,
        input.taskId,
        'TASK_TRANSITIONED',
        input.actorRole,
        input.actorId,
        input.correlationId,
        {
          from: row.status,
          to: input.to,
          fromVersion: row.version,
          ...(input.eventPayload ?? {}),
        },
      );
      const task = result.rows[0];
      if (!task) throw new Error('Task transition returned no record');
      return mapTask(task);
    });
  }

  async setPriority(
    taskId: string,
    priority: number,
    actorRole: ActorRole,
    actorId: string,
    correlationId: string,
  ): Promise<TaskRecord> {
    assertCapability(actorRole, 'TASK_PRIORITIZE');
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
      throw new RangeError('Priority must be an integer between 0 and 100');
    }
    return this.database.transaction(async (client) => {
      const row = await selectTask(client, taskId, true);
      const result = await client.query<TaskRow>(
        `UPDATE tasks SET priority = $2, version = version + 1, updated_at = now()
         WHERE id = $1
         RETURNING id, task_key, title, problem, desired_outcome, status, priority,
                   contract, version, paused_at, blocked_reason, created_at, updated_at`,
        [taskId, priority],
      );
      await appendEvent(
        client,
        taskId,
        'TASK_PRIORITY_CHANGED',
        actorRole,
        actorId,
        correlationId,
        {
          from: row.priority,
          to: priority,
        },
      );
      const task = result.rows[0];
      if (!task) throw new Error('Priority update returned no record');
      return mapTask(task);
    });
  }

  async setPaused(
    taskId: string,
    paused: boolean,
    actorRole: ActorRole,
    actorId: string,
    correlationId: string,
  ): Promise<TaskRecord> {
    assertCapability(actorRole, 'TASK_PAUSE');
    return this.database.transaction(async (client) => {
      await selectTask(client, taskId, true);
      const result = await client.query<TaskRow>(
        `UPDATE tasks SET paused_at = $2, version = version + 1, updated_at = now()
         WHERE id = $1
         RETURNING id, task_key, title, problem, desired_outcome, status, priority,
                   contract, version, paused_at, blocked_reason, created_at, updated_at`,
        [taskId, paused ? new Date() : null],
      );
      await appendEvent(
        client,
        taskId,
        paused ? 'TASK_PAUSED' : 'TASK_RESUMED',
        actorRole,
        actorId,
        correlationId,
        {},
      );
      const task = result.rows[0];
      if (!task) throw new Error('Pause update returned no record');
      return mapTask(task);
    });
  }

  async saveProposal(
    taskId: string,
    proposal: TaskProposal,
    actorId: string,
    correlationId: string,
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      await selectTask(client, taskId, true);
      await client.query(
        `UPDATE tasks SET title = $2, problem = $3, desired_outcome = $4, updated_at = now()
         WHERE id = $1`,
        [taskId, proposal.title, proposal.problem, proposal.desiredOutcome],
      );
      await appendEvent(
        client,
        taskId,
        'TASK_PROPOSAL_SAVED',
        'PLANNER',
        actorId,
        correlationId,
        {
          proposal,
        },
      );
    });
  }
}
