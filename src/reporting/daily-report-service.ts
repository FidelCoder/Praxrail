import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { DateTime } from 'luxon';
import type { Database } from '../persistence/database.js';
import type { OutboxService } from '../services/outbox-service.js';

interface TaskReportRow {
  task_key: string;
  title: string;
  status: string;
  updated_at: Date;
  pull_request_url: string | null;
}

export interface DailyReportFacts {
  completed: TaskReportRow[];
  active: TaskReportRow[];
  blocked: TaskReportRow[];
  failed: TaskReportRow[];
  totalCostUsd: number;
  retryCount: number;
}

export function reportingWindow(
  now: Date,
  timezone: string,
): { start: Date; end: Date } {
  const end = DateTime.fromJSDate(now, { zone: timezone });
  if (!end.isValid) throw new Error('Owner timezone is invalid');
  return {
    start: end.minus({ days: 1 }).toUTC().toJSDate(),
    end: end.toUTC().toJSDate(),
  };
}

function formatReport(facts: DailyReportFacts, start: Date, end: Date): string {
  const section = (title: string, tasks: TaskReportRow[]): string =>
    [
      `## ${title}`,
      ...(tasks.length === 0
        ? ['- None']
        : tasks.map(
            (task) =>
              `- ${task.task_key} · ${task.title} · ${task.status}${
                task.pull_request_url ? ` · ${task.pull_request_url}` : ''
              }`,
          )),
    ].join('\n');
  return [
    '# Praxrail daily execution report',
    `Window: ${start.toISOString()} to ${end.toISOString()}`,
    '',
    section('Completed', facts.completed),
    '',
    section('In progress', facts.active),
    '',
    section('Blocked', facts.blocked),
    '',
    section('Failures', facts.failed),
    '',
    `Cost: $${facts.totalCostUsd.toFixed(4)} · Retries: ${facts.retryCount}`,
    '',
    'Proposed next work is advisory and does not create executable tasks.',
  ].join('\n');
}

export class DailyReportService {
  constructor(
    private readonly database: Database,
    private readonly outbox: OutboxService,
  ) {}

  async generate(input: {
    projectId?: string;
    timezone: string;
    now?: Date;
    destination: string;
  }): Promise<{ reportId: string; body: string; replayed: boolean }> {
    const window = reportingWindow(input.now ?? new Date(), input.timezone);
    const tasks = await this.database.query<TaskReportRow>(
      `SELECT task.task_key, task.title, task.status, task.updated_at,
              pull.url AS pull_request_url
       FROM tasks AS task
       LEFT JOIN pull_requests AS pull ON pull.task_id = task.id
       WHERE ($1::uuid IS NULL OR task.project_id = $1)
         AND task.updated_at >= $2 AND task.updated_at < $3
       ORDER BY task.updated_at, task.task_key`,
      [input.projectId ?? null, window.start, window.end],
    );
    const costs = await this.database.query<{ total: string; retries: string }>(
      `SELECT
         COALESCE((SELECT sum(amount_usd) FROM cost_entries
           WHERE ($1::uuid IS NULL OR project_id = $1)
             AND occurred_at >= $2 AND occurred_at < $3), 0)::text AS total,
         COALESCE((SELECT count(*) FROM task_attempts AS attempt
           JOIN tasks AS task ON task.id = attempt.task_id
           WHERE ($1::uuid IS NULL OR task.project_id = $1)
             AND attempt.created_at >= $2 AND attempt.created_at < $3
             AND attempt.attempt_number > 1), 0)::text AS retries`,
      [input.projectId ?? null, window.start, window.end],
    );
    const rows = tasks.rows;
    const facts: DailyReportFacts = {
      completed: rows.filter((task) =>
        ['VERIFIED', 'MERGED', 'DEPLOYED'].includes(task.status),
      ),
      active: rows.filter((task) =>
        [
          'INBOX',
          'REFINING',
          'READY',
          'BUILDING',
          'REVIEWING',
          'CHANGES_REQUESTED',
          'CI',
          'PR_READY',
          'AWAITING_APPROVAL',
        ].includes(task.status),
      ),
      blocked: rows.filter((task) => task.status === 'BLOCKED'),
      failed: rows.filter((task) =>
        ['FAILED', 'ABANDONED'].includes(task.status),
      ),
      totalCostUsd: Number(costs.rows[0]?.total ?? 0),
      retryCount: Number(costs.rows[0]?.retries ?? 0),
    };
    const body = formatReport(facts, window.start, window.end);
    const idempotencyKey = [
      'daily-report',
      input.projectId ?? 'all',
      window.start.toISOString(),
      window.end.toISOString(),
    ].join(':');
    const reportId = randomUUID();
    const inserted = await this.database.query<{ id: string }>(
      `INSERT INTO daily_reports
        (id, project_id, window_start, window_end, timezone, factual_data,
         body, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        reportId,
        input.projectId ?? null,
        window.start,
        window.end,
        input.timezone,
        facts,
        body,
        idempotencyKey,
      ],
    );
    const replayed = inserted.rowCount === 0;
    const actualId = replayed
      ? (
          await this.database.query<{ id: string }>(
            'SELECT id FROM daily_reports WHERE idempotency_key = $1',
            [idempotencyKey],
          )
        ).rows[0]?.id
      : reportId;
    if (!actualId) throw new Error('Daily report record was not found');
    await this.outbox.enqueue({
      topic: 'notifications.telegram',
      aggregateType: 'daily_report',
      aggregateId: actualId,
      idempotencyKey: `telegram:${idempotencyKey}`,
      payload: {
        taskKey: 'PXR-REPORT',
        event: 'ACCEPTED',
        text: body.slice(0, 3_500),
        destination: input.destination,
      },
    });
    return { reportId: actualId, body, replayed };
  }
}

export class DailyReportScheduler {
  private job: Cron | null = null;

  start(input: {
    time: string;
    timezone: string;
    operation: () => Promise<void>;
  }): void {
    const [hour, minute] = input.time.split(':').map(Number);
    if (
      hour === undefined ||
      minute === undefined ||
      !Number.isInteger(hour) ||
      !Number.isInteger(minute)
    ) {
      throw new Error('Daily report time is invalid');
    }
    this.job = new Cron(
      `${minute} ${hour} * * *`,
      { timezone: input.timezone, protect: true },
      () => void input.operation(),
    );
  }

  stop(): void {
    this.job?.stop();
    this.job = null;
  }
}
