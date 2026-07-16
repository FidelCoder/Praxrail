import { randomUUID } from 'node:crypto';
import type { Database } from '../persistence/database.js';
import type { TaskService } from '../services/task-service.js';
import { RepositoryCatalog } from './repository-catalog.js';
import type { PlanningResult, RulePlanner } from './rule-planner.js';

export class PlannerService {
  private readonly catalog: RepositoryCatalog;

  constructor(
    private readonly database: Database,
    private readonly tasks: TaskService,
    private readonly planner: RulePlanner,
  ) {
    this.catalog = new RepositoryCatalog(database);
  }

  async refine(
    taskId: string,
    text: string,
    correlationId: string = randomUUID(),
  ): Promise<PlanningResult> {
    const inbox = await this.tasks.getTask(taskId);
    const refining = await this.tasks.transition({
      taskId,
      expectedStatus: 'INBOX',
      expectedVersion: inbox.version,
      to: 'REFINING',
      actorRole: 'PLANNER',
      actorId: 'rule-planner-v1',
      correlationId,
    });

    const result = this.planner.plan(text, await this.catalog.enabled());
    await this.database.query(
      `INSERT INTO planner_runs
        (id, task_id, correlation_id, planner, model, prompt_version,
         input_tokens, output_tokens, validation_result, proposal)
       VALUES ($1, $2, $3, 'RULE_PLANNER', 'deterministic-v1', 'contract-v1',
               0, 0, $4, $5)`,
      [randomUUID(), taskId, correlationId, result.kind, result.proposal],
    );
    await this.tasks.saveProposal(
      taskId,
      result.proposal,
      'rule-planner-v1',
      correlationId,
    );

    if (result.kind === 'READY') {
      await this.tasks.transition({
        taskId,
        expectedStatus: 'REFINING',
        expectedVersion: refining.version,
        to: 'READY',
        actorRole: 'PLANNER',
        actorId: 'rule-planner-v1',
        correlationId,
        contract: result.contract,
      });
      return result;
    }

    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO clarification_questions (id, task_id, question)
         VALUES ($1, $2, $3)`,
        [randomUUID(), taskId, result.question],
      );
    });
    await this.tasks.transition({
      taskId,
      expectedStatus: 'REFINING',
      expectedVersion: refining.version,
      to: 'BLOCKED',
      actorRole: 'PLANNER',
      actorId: 'rule-planner-v1',
      correlationId,
      blockedReason: result.question,
    });
    return result;
  }
}
