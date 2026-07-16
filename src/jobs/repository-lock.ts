import type { Database } from '../persistence/database.js';

interface LockRow {
  repository_id: string;
  task_id: string;
  worker_id: string;
  fencing_token: string;
  expires_at: Date;
}

export interface RepositoryLock {
  repositoryId: string;
  taskId: string;
  workerId: string;
  fencingToken: bigint;
  expiresAt: Date;
}

function mapLock(row: LockRow): RepositoryLock {
  return {
    repositoryId: row.repository_id,
    taskId: row.task_id,
    workerId: row.worker_id,
    fencingToken: BigInt(row.fencing_token),
    expiresAt: row.expires_at,
  };
}

export class RepositoryLockService {
  constructor(private readonly database: Database) {}

  async acquire(input: {
    repositoryId: string;
    taskId: string;
    attemptId?: string;
    workerId: string;
    leaseMilliseconds: number;
  }): Promise<RepositoryLock | null> {
    const expiresAt = new Date(Date.now() + input.leaseMilliseconds);
    const result = await this.database.query<LockRow>(
      `INSERT INTO repository_locks
        (repository_id, task_id, attempt_id, worker_id, fencing_token, expires_at)
       VALUES ($1, $2, $3, $4, nextval('fencing_token_sequence'), $5)
       ON CONFLICT (repository_id) DO UPDATE SET
         task_id = EXCLUDED.task_id,
         attempt_id = EXCLUDED.attempt_id,
         worker_id = EXCLUDED.worker_id,
         fencing_token = nextval('fencing_token_sequence'),
         expires_at = EXCLUDED.expires_at,
         heartbeat_at = now(),
         created_at = now()
       WHERE repository_locks.expires_at <= now()
       RETURNING repository_id, task_id, worker_id, fencing_token::text, expires_at`,
      [
        input.repositoryId,
        input.taskId,
        input.attemptId ?? null,
        input.workerId,
        expiresAt,
      ],
    );
    const row = result.rows[0];
    return row ? mapLock(row) : null;
  }

  async heartbeat(
    lock: RepositoryLock,
    leaseMilliseconds: number,
  ): Promise<RepositoryLock | null> {
    const expiresAt = new Date(Date.now() + leaseMilliseconds);
    const result = await this.database.query<LockRow>(
      `UPDATE repository_locks SET expires_at = $5, heartbeat_at = now()
       WHERE repository_id = $1 AND task_id = $2 AND worker_id = $3
         AND fencing_token = $4 AND expires_at > now()
       RETURNING repository_id, task_id, worker_id, fencing_token::text, expires_at`,
      [
        lock.repositoryId,
        lock.taskId,
        lock.workerId,
        lock.fencingToken.toString(),
        expiresAt,
      ],
    );
    const row = result.rows[0];
    return row ? mapLock(row) : null;
  }

  async release(lock: RepositoryLock): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM repository_locks
       WHERE repository_id = $1 AND task_id = $2 AND worker_id = $3 AND fencing_token = $4`,
      [
        lock.repositoryId,
        lock.taskId,
        lock.workerId,
        lock.fencingToken.toString(),
      ],
    );
    return result.rowCount === 1;
  }
}
