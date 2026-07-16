import { randomUUID } from 'node:crypto';
import type { Database } from '../persistence/database.js';

export interface WeeklyFacts {
  statusCounts: Record<string, number>;
  costUsd: number;
  retryCount: number;
  repeatedFailures: { failureClass: string; count: number }[];
  architectureDecisions: number;
  unresolvedSecurityFindings: number;
}

export interface WeeklyRecommendation {
  kind: 'PROPOSAL';
  action: 'CONTINUE' | 'DEFER' | 'STOP' | 'INVESTIGATE';
  rationale: string;
}

export function weeklyRecommendations(
  facts: WeeklyFacts,
): WeeklyRecommendation[] {
  const recommendations: WeeklyRecommendation[] = [];
  if (facts.repeatedFailures.some((failure) => failure.count >= 3)) {
    recommendations.push({
      kind: 'PROPOSAL',
      action: 'INVESTIGATE',
      rationale: 'A failure class repeated at least three times this week.',
    });
  }
  if (facts.unresolvedSecurityFindings > 0) {
    recommendations.push({
      kind: 'PROPOSAL',
      action: 'STOP',
      rationale: 'Unresolved high or critical security findings remain.',
    });
  }
  if (recommendations.length === 0) {
    recommendations.push({
      kind: 'PROPOSAL',
      action: 'CONTINUE',
      rationale:
        'The ledger contains no repeated failure or blocking security signal.',
    });
  }
  return recommendations;
}

export class WeeklyReportService {
  constructor(private readonly database: Database) {}

  async generate(input: {
    projectId: string;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<{ reportId: string; replayed: boolean }> {
    if (input.windowEnd <= input.windowStart) {
      throw new Error('Weekly report window is invalid');
    }
    const statuses = await this.database.query<{
      status: string;
      count: string;
    }>(
      `SELECT status, count(*)::text AS count FROM tasks
       WHERE project_id = $1 AND updated_at >= $2 AND updated_at < $3
       GROUP BY status ORDER BY status`,
      [input.projectId, input.windowStart, input.windowEnd],
    );
    const totals = await this.database.query<{
      cost: string;
      retries: string;
      decisions: string;
      security: string;
    }>(
      `SELECT
         COALESCE((SELECT sum(amount_usd) FROM cost_entries
           WHERE project_id = $1 AND occurred_at >= $2 AND occurred_at < $3), 0)::text AS cost,
         COALESCE((SELECT count(*) FROM task_attempts AS attempt
           JOIN tasks AS task ON task.id = attempt.task_id
           WHERE task.project_id = $1 AND attempt.attempt_number > 1
             AND attempt.created_at >= $2 AND attempt.created_at < $3), 0)::text AS retries,
         COALESCE((SELECT count(*) FROM task_events AS event
           JOIN tasks AS task ON task.id = event.task_id
           WHERE task.project_id = $1 AND event.event_type = 'ARCHITECTURE_DECISION'
             AND event.occurred_at >= $2 AND event.occurred_at < $3), 0)::text AS decisions,
         COALESCE((SELECT count(*) FROM security_assessments
           WHERE status = 'FAIL' AND created_at >= $2 AND created_at < $3), 0)::text AS security`,
      [input.projectId, input.windowStart, input.windowEnd],
    );
    const failures = await this.database.query<{
      failure_class: string;
      count: string;
    }>(
      `SELECT agent.failure_class, count(*)::text AS count
       FROM agent_runs AS agent
       JOIN tasks AS task ON task.id = agent.task_id
       WHERE task.project_id = $1 AND agent.failure_class IS NOT NULL
         AND agent.started_at >= $2 AND agent.started_at < $3
       GROUP BY agent.failure_class ORDER BY count(*) DESC, agent.failure_class`,
      [input.projectId, input.windowStart, input.windowEnd],
    );
    const total = totals.rows[0];
    const facts: WeeklyFacts = {
      statusCounts: Object.fromEntries(
        statuses.rows.map((row) => [row.status, Number(row.count)]),
      ),
      costUsd: Number(total?.cost ?? 0),
      retryCount: Number(total?.retries ?? 0),
      repeatedFailures: failures.rows.map((row) => ({
        failureClass: row.failure_class,
        count: Number(row.count),
      })),
      architectureDecisions: Number(total?.decisions ?? 0),
      unresolvedSecurityFindings: Number(total?.security ?? 0),
    };
    const recommendations = weeklyRecommendations(facts);
    const idempotencyKey = [
      'weekly-report',
      input.projectId,
      input.windowStart.toISOString(),
      input.windowEnd.toISOString(),
    ].join(':');
    const reportId = randomUUID();
    const inserted = await this.database.query(
      `INSERT INTO weekly_reports
        (id, project_id, window_start, window_end, facts, recommendations,
         idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        reportId,
        input.projectId,
        input.windowStart,
        input.windowEnd,
        facts,
        JSON.stringify(recommendations),
        idempotencyKey,
      ],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.database.query<{ id: string }>(
        'SELECT id FROM weekly_reports WHERE idempotency_key = $1',
        [idempotencyKey],
      );
      const existingId = existing.rows[0]?.id;
      if (!existingId) throw new Error('Weekly report was not found');
      return { reportId: existingId, replayed: true };
    }
    return { reportId, replayed: false };
  }
}
