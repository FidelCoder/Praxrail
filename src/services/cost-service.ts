import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.js';
import type { Database } from '../persistence/database.js';

interface SumRow {
  amount: string;
}

export class CostService {
  constructor(
    private readonly database: Database,
    private readonly limits: {
      taskUsd: number;
      dailyUsd: number;
      monthlyUsd: number;
    },
  ) {}

  async assertWithinBudget(taskId: string): Promise<void> {
    const result = await this.database.query<{
      task_total: string;
      day_total: string;
      month_total: string;
    }>(
      `SELECT
         COALESCE(SUM(amount_usd) FILTER (WHERE task_id = $1), 0)::text AS task_total,
         COALESCE(SUM(amount_usd) FILTER (WHERE occurred_at >= date_trunc('day', now())), 0)::text AS day_total,
         COALESCE(SUM(amount_usd) FILTER (WHERE occurred_at >= date_trunc('month', now())), 0)::text AS month_total
       FROM cost_entries`,
      [taskId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Cost query returned no result');
    if (Number(row.task_total) >= this.limits.taskUsd) {
      throw new DomainError(
        'Task budget is exhausted',
        'TASK_BUDGET_EXHAUSTED',
      );
    }
    if (Number(row.day_total) >= this.limits.dailyUsd) {
      throw new DomainError(
        'Daily budget is exhausted',
        'DAILY_BUDGET_EXHAUSTED',
      );
    }
    if (Number(row.month_total) >= this.limits.monthlyUsd) {
      throw new DomainError(
        'Monthly budget is exhausted',
        'MONTHLY_BUDGET_EXHAUSTED',
      );
    }
  }

  async record(input: {
    taskId?: string;
    attemptId?: string;
    projectId?: string;
    provider: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    amountUsd: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (input.amountUsd < 0 || !Number.isFinite(input.amountUsd)) {
      throw new RangeError('Cost must be a finite non-negative value');
    }
    await this.database.query(
      `INSERT INTO cost_entries
        (id, task_id, attempt_id, project_id, provider, model, input_tokens,
         output_tokens, amount_usd, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        input.taskId ?? null,
        input.attemptId ?? null,
        input.projectId ?? null,
        input.provider,
        input.model ?? null,
        input.inputTokens,
        input.outputTokens,
        input.amountUsd,
        input.metadata ?? {},
      ],
    );
  }

  async totalForTask(taskId: string): Promise<number> {
    const result = await this.database.query<SumRow>(
      'SELECT COALESCE(SUM(amount_usd), 0)::text AS amount FROM cost_entries WHERE task_id = $1',
      [taskId],
    );
    return Number(result.rows[0]?.amount ?? 0);
  }
}
