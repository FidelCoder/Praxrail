import { NotFoundError } from '../domain/errors.js';
import type { TaskStatus } from '../domain/task-state.js';
import type { Database } from '../persistence/database.js';

export interface TaskSummary {
  id: string;
  taskKey: string;
  title: string;
  status: TaskStatus;
  priority: number;
  paused: boolean;
  budgetUsd: number | null;
}

interface TaskSummaryRow {
  id: string;
  task_key: string;
  title: string;
  status: TaskStatus;
  priority: number;
  paused_at: Date | null;
  budget_usd: string | null;
}

function mapSummary(row: TaskSummaryRow): TaskSummary {
  return {
    id: row.id,
    taskKey: row.task_key,
    title: row.title,
    status: row.status,
    priority: row.priority,
    paused: Boolean(row.paused_at),
    budgetUsd: row.budget_usd === null ? null : Number(row.budget_usd),
  };
}

export class TaskQueryService {
  constructor(private readonly database: Database) {}

  async resolve(reference: string): Promise<TaskSummary> {
    const result = await this.database.query<TaskSummaryRow>(
      `SELECT id, task_key, title, status, priority, paused_at, budget_usd::text
       FROM tasks WHERE id::text = $1 OR upper(task_key) = upper($1)`,
      [reference],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError(`Task ${reference} was not found`);
    return mapSummary(row);
  }

  async active(limit = 10): Promise<TaskSummary[]> {
    const result = await this.database.query<TaskSummaryRow>(
      `SELECT id, task_key, title, status, priority, paused_at, budget_usd::text
       FROM tasks
       WHERE status NOT IN ('VERIFIED', 'CANCELLED', 'ABANDONED')
       ORDER BY priority DESC, updated_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapSummary);
  }
}
