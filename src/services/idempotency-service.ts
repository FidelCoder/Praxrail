import { createHash } from 'node:crypto';
import { ConflictError } from '../domain/errors.js';
import type { Database } from '../persistence/database.js';

interface IdempotencyRow {
  request_digest: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  response: Record<string, unknown> | null;
  locked_until: Date;
}

export function digestRequest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

export class IdempotencyService {
  constructor(private readonly database: Database) {}

  async begin(
    scope: string,
    key: string,
    request: unknown,
    leaseMilliseconds = 60_000,
  ): Promise<{ acquired: boolean; response: Record<string, unknown> | null }> {
    const requestDigest = digestRequest(request);
    const lockedUntil = new Date(Date.now() + leaseMilliseconds);
    return this.database.transaction(async (client) => {
      const result = await client.query<IdempotencyRow>(
        `INSERT INTO idempotency_keys
           (scope, key, request_digest, status, locked_until)
         VALUES ($1, $2, $3, 'PROCESSING', $4)
         ON CONFLICT (scope, key) DO UPDATE SET
           status = 'PROCESSING', locked_until = EXCLUDED.locked_until, updated_at = now()
         WHERE idempotency_keys.request_digest = EXCLUDED.request_digest
           AND idempotency_keys.status <> 'COMPLETED'
           AND idempotency_keys.locked_until <= now()
         RETURNING request_digest, status, response, locked_until`,
        [scope, key, requestDigest, lockedUntil],
      );
      if (result.rowCount === 1) return { acquired: true, response: null };

      const existing = await client.query<IdempotencyRow>(
        `SELECT request_digest, status, response, locked_until
         FROM idempotency_keys WHERE scope = $1 AND key = $2`,
        [scope, key],
      );
      const row = existing.rows[0];
      if (!row) throw new Error('Idempotency record disappeared');
      if (row.request_digest !== requestDigest) {
        throw new ConflictError(
          'Idempotency key was reused with a different request',
        );
      }
      if (row.status === 'COMPLETED')
        return { acquired: false, response: row.response };
      throw new ConflictError(
        'An operation with this idempotency key is in progress',
      );
    });
  }

  async complete(
    scope: string,
    key: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.database.query(
      `UPDATE idempotency_keys
       SET status = 'COMPLETED', response = $3, updated_at = now()
       WHERE scope = $1 AND key = $2 AND status = 'PROCESSING'`,
      [scope, key, response],
    );
    if (result.rowCount !== 1)
      throw new ConflictError('Idempotent operation is not active');
  }

  async fail(scope: string, key: string): Promise<void> {
    await this.database.query(
      `UPDATE idempotency_keys SET status = 'FAILED', updated_at = now()
       WHERE scope = $1 AND key = $2 AND status = 'PROCESSING'`,
      [scope, key],
    );
  }
}
