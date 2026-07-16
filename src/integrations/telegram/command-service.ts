import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import type { ApprovalService } from '../../services/approval-service.js';
import type { CostService } from '../../services/cost-service.js';
import type { TaskQueryService } from '../../services/task-query-service.js';
import type { TaskService } from '../../services/task-service.js';
import type { TelegramCommand } from './commands.js';

export interface CommandResult {
  kind: 'STATUS' | 'UPDATED' | 'APPROVAL' | 'BUDGET';
  message: string;
  data?: Record<string, unknown>;
}

export class TelegramCommandService {
  constructor(
    private readonly config: AppConfig,
    private readonly tasks: TaskService,
    private readonly queries: TaskQueryService,
    private readonly approvals: ApprovalService,
    private readonly costs: CostService,
  ) {}

  async execute(
    command: Exclude<TelegramCommand, { kind: 'TASK' | 'NATURAL_LANGUAGE' }>,
    actorId: string,
  ): Promise<CommandResult> {
    const correlationId = randomUUID();
    switch (command.kind) {
      case 'STATUS': {
        if (command.task) {
          const task = await this.queries.resolve(command.task);
          return {
            kind: 'STATUS',
            message: `${task.taskKey}: ${task.status}${task.paused ? ' (paused)' : ''}`,
            data: { ...task },
          };
        }
        const tasks = await this.queries.active();
        return {
          kind: 'STATUS',
          message:
            tasks.length === 0
              ? 'No active tasks.'
              : tasks
                  .map((task) => `${task.taskKey}: ${task.status}`)
                  .join('\n'),
          data: { tasks },
        };
      }
      case 'PAUSE':
      case 'RESUME': {
        const task = await this.queries.resolve(command.task);
        const updated = await this.tasks.setPaused(
          task.id,
          command.kind === 'PAUSE',
          'OWNER',
          actorId,
          correlationId,
        );
        return {
          kind: 'UPDATED',
          message: `${updated.taskKey} ${command.kind === 'PAUSE' ? 'paused' : 'resumed'}.`,
        };
      }
      case 'PRIORITY': {
        const task = await this.queries.resolve(command.task);
        const updated = await this.tasks.setPriority(
          task.id,
          command.priority,
          'OWNER',
          actorId,
          correlationId,
        );
        return {
          kind: 'UPDATED',
          message: `${updated.taskKey} priority set to ${updated.priority}.`,
        };
      }
      case 'APPROVE':
      case 'REJECT':
        await this.approvals.decide({
          approvalId: command.approvalId,
          actorId,
          token: command.token,
          approved: command.kind === 'APPROVE',
          reason: command.reason,
        });
        return {
          kind: 'APPROVAL',
          message:
            command.kind === 'APPROVE'
              ? 'Approval recorded.'
              : 'Rejection recorded.',
        };
      case 'BUDGET': {
        if (!command.task) {
          return {
            kind: 'BUDGET',
            message: `Limits: task $${this.config.budget.taskUsd}, daily $${this.config.budget.dailyUsd}, monthly $${this.config.budget.monthlyUsd}.`,
            data: { ...this.config.budget },
          };
        }
        const task = await this.queries.resolve(command.task);
        const spent = await this.costs.totalForTask(task.id);
        return {
          kind: 'BUDGET',
          message: `${task.taskKey}: $${spent.toFixed(4)} spent of $${(task.budgetUsd ?? this.config.budget.taskUsd).toFixed(2)}.`,
          data: {
            taskId: task.id,
            spent,
            limit: task.budgetUsd ?? this.config.budget.taskUsd,
          },
        };
      }
    }
  }
}
