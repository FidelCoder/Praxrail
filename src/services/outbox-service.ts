import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import type { Database } from '../persistence/database.js';

interface OutboxRow {
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface OutboxMessage {
  id: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  attempts: number;
}

function mapMessage(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    topic: row.topic,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    attempts: row.attempts,
  };
}

export class OutboxService {
  constructor(private readonly database: Database) {}

  async enqueue(input: {
    topic: string;
    aggregateType: string;
    aggregateId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): Promise<{ id: string; replayed: boolean }> {
    const id = randomUUID();
    const inserted = await this.database.query<{ id: string }>(
      `INSERT INTO outbox_events
        (id, topic, aggregate_type, aggregate_id, idempotency_key, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        id,
        input.topic,
        input.aggregateType,
        input.aggregateId,
        input.idempotencyKey,
        input.payload,
      ],
    );
    if (inserted.rowCount === 1) return { id, replayed: false };

    const existing = await this.database.query<{
      id: string;
      same_request: boolean;
    }>(
      `SELECT id,
              topic = $2 AND aggregate_type = $3 AND aggregate_id = $4
                AND payload = $5::jsonb AS same_request
       FROM outbox_events WHERE idempotency_key = $1`,
      [
        input.idempotencyKey,
        input.topic,
        input.aggregateType,
        input.aggregateId,
        input.payload,
      ],
    );
    const prior = existing.rows[0];
    if (!prior) throw new NotFoundError('Outbox replay record was not found');
    if (!prior.same_request) {
      throw new ConflictError(
        'Outbox idempotency key was reused for a different request',
      );
    }
    return { id: prior.id, replayed: true };
  }

  async claim(
    workerId: string,
    limit = 20,
    topic?: string,
  ): Promise<OutboxMessage[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Outbox claim limit must be between 1 and 100');
    }
    return this.database.transaction(async (client) => {
      const result = await client.query<OutboxRow>(
        `WITH candidates AS (
           SELECT id FROM outbox_events
           WHERE status IN ('PENDING', 'FAILED') AND available_at <= now()
             AND ($3::text IS NULL OR topic = $3)
             AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
           ORDER BY available_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE outbox_events AS event SET
           status = 'PROCESSING', locked_at = now(), locked_by = $1,
           attempts = attempts + 1
         FROM candidates WHERE event.id = candidates.id
         RETURNING event.id, event.topic, event.aggregate_type,
                   event.aggregate_id, event.idempotency_key, event.payload,
                   event.attempts`,
        [workerId, limit, topic ?? null],
      );
      return result.rows.map(mapMessage);
    });
  }

  async complete(id: string, workerId: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE outbox_events SET status = 'DELIVERED', delivered_at = now(),
         locked_at = NULL, locked_by = NULL, last_error = NULL
       WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2`,
      [id, workerId],
    );
    if (result.rowCount !== 1) {
      throw new ConflictError('Outbox message is not owned by this worker');
    }
  }

  async fail(
    id: string,
    workerId: string,
    error: string,
    retryDelayMilliseconds: number,
  ): Promise<void> {
    const result = await this.database.query(
      `UPDATE outbox_events SET status = 'FAILED',
         available_at = now() + ($4 * interval '1 millisecond'),
         locked_at = NULL, locked_by = NULL, last_error = $3
       WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2`,
      [id, workerId, error.slice(0, 1_000), retryDelayMilliseconds],
    );
    if (result.rowCount !== 1) {
      throw new ConflictError('Outbox message is not owned by this worker');
    }
  }
}
