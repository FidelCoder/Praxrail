import { randomUUID } from 'node:crypto';
import type { TaskEvent, TaskOutputChunk } from 'praxrail-core';
import type { Database } from '../persistence/database.js';
import { redactText } from '../observability/redaction.js';

interface TaskEventRow {
  id: string;
  task_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string;
  correlation_id: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

interface TaskOutputRow {
  id: string;
  task_id: string;
  attempt_id: string | null;
  stream: 'STDOUT' | 'STDERR' | 'SYSTEM';
  content: string;
  truncated: boolean;
  occurred_at: Date;
}

function mapEvent(row: TaskEventRow): TaskEvent {
  return {
    id: Number(row.id),
    taskId: row.task_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    correlationId: row.correlation_id,
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
  };
}

export class EventStreamService {
  constructor(private readonly database: Database) {}

  async events(input: {
    cursor: number;
    taskId?: string;
    limit: number;
  }): Promise<{ events: TaskEvent[]; nextCursor: number }> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    const result = await this.database.query<TaskEventRow>(
      `SELECT id::text, task_id, event_type, actor_type, actor_id,
              correlation_id, payload, occurred_at
       FROM task_events
       WHERE id > $1 AND ($2::uuid IS NULL OR task_id = $2)
       ORDER BY id LIMIT $3`,
      [input.cursor, input.taskId ?? null, limit],
    );
    const events = result.rows.map(mapEvent);
    return {
      events,
      nextCursor: events.at(-1)?.id ?? input.cursor,
    };
  }

  async output(input: {
    cursor: number;
    taskId: string;
    limit: number;
  }): Promise<{ chunks: TaskOutputChunk[]; nextCursor: number }> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    const result = await this.database.query<TaskOutputRow>(
      `SELECT id::text, task_id, attempt_id, stream, content, truncated,
              occurred_at
       FROM task_output_chunks
       WHERE id > $1 AND task_id = $2
       ORDER BY id LIMIT $3`,
      [input.cursor, input.taskId, limit],
    );
    const chunks = result.rows.map((row) => ({
      id: Number(row.id),
      taskId: row.task_id,
      attemptId: row.attempt_id,
      stream: row.stream,
      content: row.content,
      truncated: row.truncated,
      occurredAt: row.occurred_at.toISOString(),
    }));
    return {
      chunks,
      nextCursor: chunks.at(-1)?.id ?? input.cursor,
    };
  }

  async appendOutput(input: {
    taskId: string;
    attemptId?: string;
    stream: 'STDOUT' | 'STDERR' | 'SYSTEM';
    content: string;
  }): Promise<number> {
    const redacted = redactText(input.content);
    const maximum = 32_000;
    const marker = '\n[Praxrail output truncated]\n';
    const truncated = Buffer.byteLength(redacted, 'utf8') > maximum;
    const prefix = Buffer.from(redacted, 'utf8')
      .subarray(0, maximum - Buffer.byteLength(marker, 'utf8'))
      .toString('utf8');
    const content = truncated ? prefix + marker : redacted;
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO task_output_chunks
        (task_id, attempt_id, stream, content, truncated)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
      [input.taskId, input.attemptId ?? null, input.stream, content, truncated],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('Output chunk was not returned');
    return Number(id);
  }

  async recordRuntimeEvent(input: {
    eventType: string;
    actorType: string;
    actorId: string;
    taskId?: string;
    workerId?: string;
    correlationId?: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO runtime_events
        (event_type, actor_type, actor_id, task_id, worker_id,
         correlation_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.eventType,
        input.actorType,
        input.actorId,
        input.taskId ?? null,
        input.workerId ?? null,
        input.correlationId ?? randomUUID(),
        input.payload ?? {},
      ],
    );
  }
}
