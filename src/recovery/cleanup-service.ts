import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import type { Database } from '../persistence/database.js';
import { GitClient } from '../repositories/git-client.js';
import { assertNoSymlinkEscape } from '../repositories/path-policy.js';

interface CleanupRow {
  id: string;
  task_id: string;
  repository_id: string;
  worktree_path: string;
  mirror_path: string;
}

export class DiskPressureGuard {
  constructor(
    private readonly root: string,
    private readonly minimumFreeBytes: number,
  ) {}

  async canClaimWork(): Promise<boolean> {
    const stats = await statfs(this.root);
    return stats.bavail * stats.bsize >= this.minimumFreeBytes;
  }
}

export class CleanupService {
  constructor(
    private readonly database: Database,
    private readonly worktreeRoot: string,
    private readonly git: GitClient = new GitClient(),
  ) {}

  async cleanupTerminalWorktrees(limit = 50): Promise<number> {
    const result = await this.database.query<CleanupRow>(
      `SELECT ref.id, ref.task_id, ref.repository_id, ref.worktree_path,
              repository.mirror_path
       FROM git_refs AS ref
       JOIN tasks AS task ON task.id = ref.task_id
       JOIN repositories AS repository ON repository.id = ref.repository_id
       LEFT JOIN repository_locks AS lock
         ON lock.repository_id = ref.repository_id AND lock.expires_at > now()
       WHERE ref.status IN ('ACTIVE', 'ORPHANED')
         AND ref.worktree_path IS NOT NULL
         AND repository.mirror_path IS NOT NULL
         AND task.status IN ('VERIFIED', 'CANCELLED', 'ABANDONED', 'SUPERSEDED')
         AND lock.repository_id IS NULL
         AND EXISTS (
           SELECT 1 FROM task_events AS event WHERE event.task_id = task.id
         )
       ORDER BY ref.updated_at
       LIMIT $1`,
      [limit],
    );
    for (const row of result.rows) {
      const worktreePath = await assertNoSymlinkEscape(
        this.worktreeRoot,
        row.worktree_path,
      );
      await this.git.removeWorktree(row.mirror_path, worktreePath);
      await this.database.query(
        `UPDATE git_refs SET status = 'CLEANED', worktree_path = NULL,
           cleaned_at = now(), updated_at = now() WHERE id = $1`,
        [row.id],
      );
    }
    return result.rowCount ?? 0;
  }
}

export class OperatorRecoveryService {
  constructor(private readonly database: Database) {}

  async releaseExpiredRepositoryLock(input: {
    repositoryId: string;
    actorId: string;
    reason: string;
  }): Promise<boolean> {
    if (input.reason.trim().length < 5) {
      throw new Error('Operator recovery requires a meaningful reason');
    }
    return this.database.transaction(async (client) => {
      const removed = await client.query(
        `DELETE FROM repository_locks
         WHERE repository_id = $1 AND expires_at <= now()`,
        [input.repositoryId],
      );
      await client.query(
        `INSERT INTO operator_actions
          (id, repository_id, action, reason, actor_id, previous_value, new_value)
         VALUES ($1, $2, 'RELEASE_EXPIRED_LOCK', $3, $4, $5, $6)`,
        [
          randomUUID(),
          input.repositoryId,
          input.reason,
          input.actorId,
          { lockPresent: removed.rowCount === 1 },
          { lockPresent: false },
        ],
      );
      return removed.rowCount === 1;
    });
  }

  async retryOutbox(input: {
    outboxId: string;
    actorId: string;
    reason: string;
  }): Promise<void> {
    if (input.reason.trim().length < 5) {
      throw new Error('Operator recovery requires a meaningful reason');
    }
    await this.database.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE outbox_events SET status = 'FAILED', available_at = now(),
           locked_at = NULL, locked_by = NULL
         WHERE id = $1 AND status IN ('FAILED', 'PROCESSING')`,
        [input.outboxId],
      );
      if (updated.rowCount !== 1) {
        throw new Error('Outbox event is not recoverable');
      }
      await client.query(
        `INSERT INTO operator_actions
          (id, action, reason, actor_id, previous_value, new_value)
         VALUES ($1, 'RETRY_OUTBOX', $2, $3, $4, $5)`,
        [
          randomUUID(),
          input.reason,
          input.actorId,
          { outboxId: input.outboxId },
          { status: 'FAILED', available: true },
        ],
      );
    });
  }
}
