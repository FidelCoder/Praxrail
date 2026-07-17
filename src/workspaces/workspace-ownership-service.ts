import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertWorkspaceOwnershipTransition,
  type ApiActor,
  type WorkspaceOwnership,
  type WorkspaceOwnershipState,
} from 'praxrail-core';
import type pg from 'pg';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import type { Database } from '../persistence/database.js';
import { GitClient } from '../repositories/git-client.js';
import { assertNoSymlinkEscape } from '../repositories/path-policy.js';
import { assertPushContentSafe } from '../security/release-assessment.js';
import { assertCapability } from '../security/permissions.js';

interface OwnershipRow {
  task_id: string;
  repository_id: string;
  git_ref_id: string | null;
  assignment_id: string | null;
  state: WorkspaceOwnershipState;
  owner_actor_id: string | null;
  requested_actor_id: string | null;
  worker_id: string | null;
  fencing_token: string;
  lease_expires_at: Date;
  reason: string | null;
}

interface GitRefRow {
  id: string;
  worktree_path: string | null;
  base_sha: string;
}

function mapOwnership(row: OwnershipRow): WorkspaceOwnership {
  return {
    taskId: row.task_id,
    repositoryId: row.repository_id,
    gitRefId: row.git_ref_id,
    assignmentId: row.assignment_id,
    state: row.state,
    ownerActorId: row.owner_actor_id,
    workerId: row.worker_id,
    fencingToken: row.fencing_token,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    reason: row.reason,
  };
}

async function ownershipRow(
  client: pg.PoolClient,
  taskId: string,
  forUpdate = false,
): Promise<OwnershipRow> {
  const result = await client.query<OwnershipRow>(
    `SELECT task_id, repository_id, git_ref_id, assignment_id, state,
            owner_actor_id, requested_actor_id, worker_id,
            fencing_token::text, lease_expires_at, reason
     FROM workspace_ownerships WHERE task_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [taskId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Task workspace ownership was not found');
  return row;
}

async function appendEvent(
  client: pg.PoolClient,
  input: {
    taskId: string;
    eventType: string;
    actor: ApiActor;
    correlationId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO task_events
      (task_id, event_type, actor_type, actor_id, correlation_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.taskId,
      input.eventType,
      input.actor.role,
      input.actor.actorId,
      input.correlationId,
      input.payload,
    ],
  );
}

export class WorkspaceOwnershipService {
  constructor(
    private readonly database: Database,
    private readonly workspaceRoot: string,
    private readonly git: GitClient = new GitClient(),
  ) {}

  async get(taskId: string): Promise<WorkspaceOwnership> {
    const result = await this.database.query<OwnershipRow>(
      `SELECT task_id, repository_id, git_ref_id, assignment_id, state,
              owner_actor_id, requested_actor_id, worker_id,
              fencing_token::text, lease_expires_at, reason
       FROM workspace_ownerships WHERE task_id = $1`,
      [taskId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Task workspace ownership was not found');
    return mapOwnership(row);
  }

  async bindGitRef(input: {
    taskId: string;
    gitRefId: string;
    workerId: string;
    fencingToken: string;
    actor: ApiActor;
  }): Promise<WorkspaceOwnership> {
    const result = await this.database.query<OwnershipRow>(
      `UPDATE workspace_ownerships AS ownership SET git_ref_id = $2,
         updated_at = now()
       FROM git_refs AS ref
       WHERE ownership.task_id = $1 AND ownership.state = 'AGENT_OWNED'
         AND ownership.worker_id = $3 AND ownership.fencing_token = $4
         AND ref.id = $2 AND ref.task_id = ownership.task_id
         AND ref.repository_id = ownership.repository_id
         AND EXISTS (
           SELECT 1 FROM workers AS worker WHERE worker.id = $3
             AND worker.status = 'ACTIVE' AND worker.lease_expires_at > now()
             AND (worker.identity_id = $5 OR $6 = true)
         )
       RETURNING ownership.task_id, ownership.repository_id,
         ownership.git_ref_id, ownership.assignment_id, ownership.state,
         ownership.owner_actor_id, ownership.requested_actor_id,
         ownership.worker_id, ownership.fencing_token::text,
         ownership.lease_expires_at, ownership.reason`,
      [
        input.taskId,
        input.gitRefId,
        input.workerId,
        input.fencingToken,
        input.actor.identityId,
        input.actor.role === 'OPERATOR',
      ],
    );
    const row = result.rows[0];
    if (!row) throw new ConflictError('Worker cannot bind this worktree');
    return mapOwnership(row);
  }

  async requestAttach(input: {
    taskId: string;
    actor: ApiActor;
    reason: string;
    leaseMilliseconds: number;
    correlationId: string;
  }): Promise<WorkspaceOwnership> {
    assertCapability(input.actor.role, 'WORKSPACE_ATTACH');
    return this.database.transaction(async (client) => {
      const current = await ownershipRow(client, input.taskId, true);
      assertWorkspaceOwnershipTransition(current.state, 'PAUSING');
      if (!current.git_ref_id) {
        throw new ConflictError('Task worktree is not ready for attachment');
      }
      if (current.assignment_id) {
        await client.query(
          `UPDATE worker_assignments SET status = 'CANCELLING'
           WHERE id = $1 AND status IN ('CLAIMED', 'RUNNING')`,
          [current.assignment_id],
        );
      }
      const expiresAt = new Date(Date.now() + input.leaseMilliseconds);
      const result = await client.query<OwnershipRow>(
        `UPDATE workspace_ownerships SET state = 'PAUSING',
           requested_actor_id = $2, reason = $3, lease_expires_at = $4,
           updated_at = now() WHERE task_id = $1
         RETURNING task_id, repository_id, git_ref_id, assignment_id, state,
           owner_actor_id, requested_actor_id, worker_id,
           fencing_token::text, lease_expires_at, reason`,
        [input.taskId, input.actor.actorId, input.reason, expiresAt],
      );
      await appendEvent(client, {
        taskId: input.taskId,
        eventType: 'WORKSPACE_HANDOFF_REQUESTED',
        actor: input.actor,
        correlationId: input.correlationId,
        payload: { from: current.state, to: 'PAUSING' },
      });
      const row = result.rows[0];
      if (!row) throw new Error('Workspace handoff request returned no record');
      return mapOwnership(row);
    });
  }

  async acknowledgeAgentPaused(input: {
    taskId: string;
    workerId: string;
    fencingToken: string;
    actor: ApiActor;
    correlationId: string;
  }): Promise<WorkspaceOwnership> {
    assertCapability(input.actor.role, 'WORKER_HEARTBEAT');
    return this.database.transaction(async (client) => {
      const current = await ownershipRow(client, input.taskId, true);
      assertWorkspaceOwnershipTransition(current.state, 'HUMAN_OWNED');
      if (
        current.worker_id !== input.workerId ||
        current.fencing_token !== input.fencingToken ||
        !current.requested_actor_id
      ) {
        throw new ConflictError('Agent pause acknowledgement is fenced');
      }
      const workerIdentity = await client.query<{ valid: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM workers WHERE id = $1
             AND status = 'ACTIVE' AND lease_expires_at > now()
             AND (identity_id = $2 OR $3 = true)
         ) AS valid`,
        [
          input.workerId,
          input.actor.identityId,
          input.actor.role === 'OPERATOR',
        ],
      );
      if (!workerIdentity.rows[0]?.valid) {
        throw new ConflictError('Worker identity does not own this assignment');
      }
      const next = await client.query<{ value: string }>(
        `SELECT nextval('fencing_token_sequence')::text AS value`,
      );
      const fencingToken = next.rows[0]?.value;
      if (!fencingToken) throw new Error('Fencing sequence returned no value');
      const lock = await client.query(
        `UPDATE repository_locks SET worker_id = $5, fencing_token = $4,
           expires_at = $6, heartbeat_at = now()
         WHERE repository_id = $1 AND task_id = $2 AND worker_id = $3
           AND fencing_token = $7 AND expires_at > now()`,
        [
          current.repository_id,
          input.taskId,
          input.workerId,
          fencingToken,
          `human:${current.requested_actor_id}`,
          current.lease_expires_at,
          input.fencingToken,
        ],
      );
      if (lock.rowCount !== 1)
        throw new ConflictError('Repository lock was lost');
      if (current.assignment_id) {
        await client.query(
          `UPDATE worker_assignments SET status = 'CANCELLED',
             completed_at = now() WHERE id = $1 AND status = 'CANCELLING'`,
          [current.assignment_id],
        );
      }
      const result = await client.query<OwnershipRow>(
        `UPDATE workspace_ownerships SET state = 'HUMAN_OWNED',
           owner_actor_id = requested_actor_id, requested_actor_id = NULL,
           assignment_id = NULL, worker_id = NULL, fencing_token = $2,
           updated_at = now() WHERE task_id = $1
         RETURNING task_id, repository_id, git_ref_id, assignment_id, state,
           owner_actor_id, requested_actor_id, worker_id,
           fencing_token::text, lease_expires_at, reason`,
        [input.taskId, fencingToken],
      );
      await appendEvent(client, {
        taskId: input.taskId,
        eventType: 'WORKSPACE_HUMAN_OWNED',
        actor: input.actor,
        correlationId: input.correlationId,
        payload: { from: current.state, to: 'HUMAN_OWNED', fencingToken },
      });
      const row = result.rows[0];
      if (!row) throw new Error('Human handoff returned no record');
      return mapOwnership(row);
    });
  }

  async returnToAgent(input: {
    taskId: string;
    actor: ApiActor;
    fencingToken: string;
    reason: string;
    correlationId: string;
  }): Promise<{
    ownership: WorkspaceOwnership;
    changedFiles: string[];
    diffDigest: string;
  }> {
    assertCapability(input.actor.role, 'WORKSPACE_RETURN');
    const current = await this.get(input.taskId);
    if (
      current.state !== 'HUMAN_OWNED' ||
      current.ownerActorId !== input.actor.actorId ||
      current.fencingToken !== input.fencingToken ||
      new Date(current.leaseExpiresAt) <= new Date()
    ) {
      throw new ConflictError('Human workspace ownership is absent or expired');
    }
    if (!current.gitRefId)
      throw new ConflictError('Task has no bound worktree');
    const refs = await this.database.query<GitRefRow>(
      `SELECT id, worktree_path, base_sha FROM git_refs
       WHERE id = $1 AND task_id = $2 AND status = 'ACTIVE'`,
      [current.gitRefId, input.taskId],
    );
    const ref = refs.rows[0];
    if (!ref?.worktree_path)
      throw new NotFoundError('Active task worktree was not found');
    const worktree = await assertNoSymlinkEscape(
      this.workspaceRoot,
      ref.worktree_path,
    );
    const changedFiles = await this.git.changedFiles(worktree, ref.base_sha);
    const diff = await this.git.diff(worktree, ref.base_sha);
    try {
      if (
        changedFiles.includes('.gitmodules') ||
        (await this.git.hasSubmoduleChanges(worktree, ref.base_sha))
      ) {
        throw new Error('Submodule changes are not allowed during handoff');
      }
      let inspectedContent = diff;
      for (const filename of changedFiles) {
        const changedPath = path.join(worktree, filename);
        await assertNoSymlinkEscape(worktree, changedPath, true);
        try {
          inspectedContent += (await readFile(changedPath)).toString('utf8');
        } catch (error) {
          const missing =
            error instanceof Error &&
            'code' in error &&
            (error as NodeJS.ErrnoException).code === 'ENOENT';
          if (!missing) throw error;
        }
        if (Buffer.byteLength(inspectedContent, 'utf8') > 2 * 1024 * 1024) {
          throw new Error('Returned workspace evidence is too large');
        }
      }
      if (changedFiles.length > 0) {
        assertPushContentSafe(inspectedContent, changedFiles);
      }
    } catch {
      throw new ConflictError('Returned workspace failed safety validation');
    }
    const diffDigest = createHash('sha256').update(diff).digest('hex');
    const ownership = await this.database.transaction(async (client) => {
      const locked = await ownershipRow(client, input.taskId, true);
      if (
        locked.state !== 'HUMAN_OWNED' ||
        locked.owner_actor_id !== input.actor.actorId ||
        locked.fencing_token !== input.fencingToken
      ) {
        throw new ConflictError('Workspace ownership changed during return');
      }
      assertWorkspaceOwnershipTransition(locked.state, 'RETURNING');
      const result = await client.query<OwnershipRow>(
        `UPDATE workspace_ownerships SET state = 'RETURNING', reason = $2,
           updated_at = now() WHERE task_id = $1
         RETURNING task_id, repository_id, git_ref_id, assignment_id, state,
           owner_actor_id, requested_actor_id, worker_id,
           fencing_token::text, lease_expires_at, reason`,
        [input.taskId, input.reason],
      );
      await appendEvent(client, {
        taskId: input.taskId,
        eventType: 'WORKSPACE_RETURNED',
        actor: input.actor,
        correlationId: input.correlationId,
        payload: { changedFiles, diffDigest },
      });
      const row = result.rows[0];
      if (!row) throw new Error('Workspace return returned no record');
      return mapOwnership(row);
    });
    return { ownership, changedFiles, diffDigest };
  }

  async resumeAgent(input: {
    taskId: string;
    workerId: string;
    workerFencingToken: string;
    leaseMilliseconds: number;
    actor: ApiActor;
    correlationId: string;
  }): Promise<WorkspaceOwnership> {
    assertCapability(input.actor.role, 'TASK_CLAIM');
    return this.database.transaction(async (client) => {
      const current = await ownershipRow(client, input.taskId, true);
      assertWorkspaceOwnershipTransition(current.state, 'AGENT_OWNED');
      const worker = await client.query<{
        repository_ids: string[];
        profiles: string[];
      }>(
        `SELECT repository_ids, profiles FROM workers
         WHERE id = $1 AND fencing_token = $2 AND status = 'ACTIVE'
           AND (identity_id = $3 OR $4 = true)
           AND lease_expires_at > now() FOR UPDATE`,
        [
          input.workerId,
          input.workerFencingToken,
          input.actor.identityId,
          input.actor.role === 'OPERATOR',
        ],
      );
      const allowed = worker.rows[0];
      if (!allowed?.repository_ids.includes(current.repository_id)) {
        throw new ConflictError('Worker is not authorized for this repository');
      }
      const repository = await client.query<{ worker_profile: string }>(
        `SELECT worker_profile FROM repositories WHERE id = $1`,
        [current.repository_id],
      );
      if (
        !allowed.profiles.includes(repository.rows[0]?.worker_profile ?? '')
      ) {
        throw new ConflictError('Worker profile does not match the repository');
      }
      const attempt = await client.query<{ id: string }>(
        `SELECT id FROM task_attempts WHERE task_id = $1
         ORDER BY attempt_number DESC LIMIT 1`,
        [input.taskId],
      );
      const attemptId = attempt.rows[0]?.id;
      if (!attemptId) throw new NotFoundError('Task attempt was not found');
      const next = await client.query<{ value: string }>(
        `SELECT nextval('fencing_token_sequence')::text AS value`,
      );
      const fencingToken = next.rows[0]?.value;
      if (!fencingToken) throw new Error('Fencing sequence returned no value');
      const expiresAt = new Date(Date.now() + input.leaseMilliseconds);
      const assignmentId = randomUUID();
      await client.query(
        `INSERT INTO worker_assignments
          (id, worker_id, task_id, repository_id, attempt_id, status,
           fencing_token, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, 'CLAIMED', $6, $7)`,
        [
          assignmentId,
          input.workerId,
          input.taskId,
          current.repository_id,
          attemptId,
          fencingToken,
          expiresAt,
        ],
      );
      const lock = await client.query(
        `UPDATE repository_locks SET worker_id = $3, fencing_token = $4,
           expires_at = $5, heartbeat_at = now()
         WHERE repository_id = $1 AND task_id = $2 AND fencing_token = $6`,
        [
          current.repository_id,
          input.taskId,
          input.workerId,
          fencingToken,
          expiresAt,
          current.fencing_token,
        ],
      );
      if (lock.rowCount !== 1)
        throw new ConflictError('Human repository lock was lost');
      const result = await client.query<OwnershipRow>(
        `UPDATE workspace_ownerships SET state = 'AGENT_OWNED',
           owner_actor_id = NULL, assignment_id = $2, worker_id = $3,
           fencing_token = $4, lease_expires_at = $5, reason = NULL,
           updated_at = now() WHERE task_id = $1
         RETURNING task_id, repository_id, git_ref_id, assignment_id, state,
           owner_actor_id, requested_actor_id, worker_id,
           fencing_token::text, lease_expires_at, reason`,
        [input.taskId, assignmentId, input.workerId, fencingToken, expiresAt],
      );
      await appendEvent(client, {
        taskId: input.taskId,
        eventType: 'WORKSPACE_AGENT_RESUMED',
        actor: input.actor,
        correlationId: input.correlationId,
        payload: { assignmentId, workerId: input.workerId, fencingToken },
      });
      const row = result.rows[0];
      if (!row) throw new Error('Agent resume returned no record');
      return mapOwnership(row);
    });
  }

  async recover(input: {
    taskId: string;
    actor: ApiActor;
    direction: 'HUMAN' | 'AGENT';
    reason: string;
    leaseMilliseconds: number;
    correlationId: string;
  }): Promise<WorkspaceOwnership> {
    assertCapability(input.actor.role, 'WORKSPACE_RECOVER');
    return this.database.transaction(async (client) => {
      const current = await ownershipRow(client, input.taskId, true);
      const target = input.direction === 'HUMAN' ? 'HUMAN_OWNED' : 'RETURNING';
      assertWorkspaceOwnershipTransition(current.state, target);
      const next = await client.query<{ value: string }>(
        `SELECT nextval('fencing_token_sequence')::text AS value`,
      );
      const fencingToken = next.rows[0]?.value;
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
         WHERE repository_locks.expires_at <= now() OR repository_locks.task_id = $2`,
        [
          current.repository_id,
          input.taskId,
          `human:${input.actor.actorId}`,
          fencingToken,
          expiresAt,
        ],
      );
      if (lock.rowCount !== 1) {
        throw new ConflictError('Repository is owned by an active lease');
      }
      const result = await client.query<OwnershipRow>(
        `UPDATE workspace_ownerships SET state = $2,
           owner_actor_id = $3, requested_actor_id = NULL,
           assignment_id = NULL, worker_id = NULL, fencing_token = $4,
           lease_expires_at = $5, reason = $6, updated_at = now()
         WHERE task_id = $1
         RETURNING task_id, repository_id, git_ref_id, assignment_id, state,
           owner_actor_id, requested_actor_id, worker_id,
           fencing_token::text, lease_expires_at, reason`,
        [
          input.taskId,
          target,
          target === 'HUMAN_OWNED' ? input.actor.actorId : null,
          fencingToken,
          expiresAt,
          input.reason,
        ],
      );
      await appendEvent(client, {
        taskId: input.taskId,
        eventType: 'WORKSPACE_RECOVERED',
        actor: input.actor,
        correlationId: input.correlationId,
        payload: { from: current.state, to: target, fencingToken },
      });
      const row = result.rows[0];
      if (!row) throw new Error('Workspace recovery returned no record');
      return mapOwnership(row);
    });
  }
}
