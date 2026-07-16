import { createHash, randomUUID } from 'node:crypto';
import type { TaskStatus } from '../domain/task-state.js';
import type { Database } from '../persistence/database.js';
import type { TaskService } from '../services/task-service.js';

export interface ExternalPullRequestFacts {
  state: 'OPEN' | 'CLOSED';
  merged: boolean;
  headSha: string;
  branchExists: boolean;
  requiredChecks: 'PENDING' | 'PASSED' | 'FAILED';
}

export interface ReconciliationGateway {
  pullRequest(
    repositoryFullName: string,
    number: number,
  ): Promise<ExternalPullRequestFacts>;
}

export type ReconciliationDecision =
  | 'MARK_MERGED'
  | 'MARK_CHANGES_REQUESTED'
  | 'MARK_PR_READY'
  | 'MARK_CI_FAILED'
  | 'RECORD_BRANCH_DELETED'
  | 'NOOP';

export function decideReconciliation(input: {
  taskStatus: TaskStatus;
  internalHeadSha: string;
  external: ExternalPullRequestFacts;
}): ReconciliationDecision {
  if (input.external.headSha !== input.internalHeadSha) {
    return 'MARK_CHANGES_REQUESTED';
  }
  if (
    input.external.merged &&
    ['PR_READY', 'AWAITING_APPROVAL'].includes(input.taskStatus)
  ) {
    return 'MARK_MERGED';
  }
  if (
    input.external.state === 'CLOSED' &&
    ['PR_READY', 'AWAITING_APPROVAL'].includes(input.taskStatus)
  ) {
    return 'MARK_CHANGES_REQUESTED';
  }
  if (input.taskStatus === 'CI' && input.external.requiredChecks === 'PASSED') {
    return 'MARK_PR_READY';
  }
  if (input.taskStatus === 'CI' && input.external.requiredChecks === 'FAILED') {
    return 'MARK_CI_FAILED';
  }
  if (!input.external.branchExists && !input.external.merged) {
    return 'RECORD_BRANCH_DELETED';
  }
  return 'NOOP';
}

interface PullTaskRow {
  task_id: string;
  repository_id: string;
  repository_full_name: string;
  number: number;
  head_sha: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  task_status: TaskStatus;
  task_version: number;
}

export class ReconciliationService {
  constructor(
    private readonly database: Database,
    private readonly tasks: TaskService,
    private readonly gateway: ReconciliationGateway,
  ) {}

  async reconcileOpenPullRequests(): Promise<number> {
    const result = await this.database.query<PullTaskRow>(
      `SELECT pull.task_id, pull.repository_id,
              repository.full_name AS repository_full_name,
              pull.number, pull.head_sha, pull.state,
              task.status AS task_status, task.version AS task_version
       FROM pull_requests AS pull
       JOIN tasks AS task ON task.id = pull.task_id
       JOIN repositories AS repository ON repository.id = pull.repository_id
       WHERE pull.state = 'OPEN'
       ORDER BY pull.updated_at`,
    );
    for (const row of result.rows) await this.reconcile(row);
    return result.rowCount ?? 0;
  }

  private async reconcile(row: PullTaskRow): Promise<void> {
    const external = await this.gateway.pullRequest(
      row.repository_full_name,
      row.number,
    );
    const decision = decideReconciliation({
      taskStatus: row.task_status,
      internalHeadSha: row.head_sha,
      external,
    });
    const factsDigest = createHash('sha256')
      .update(JSON.stringify(external))
      .digest('hex');
    const idempotencyKey = [
      'github-reconcile',
      row.repository_id,
      String(row.number),
      decision,
      factsDigest,
    ].join(':');
    const existing = await this.database.query(
      `SELECT 1 FROM reconciliation_actions WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if ((existing.rowCount ?? 0) > 0) return;
    const correlationId = randomUUID();
    if (decision === 'MARK_MERGED') {
      await this.tasks.transition({
        taskId: row.task_id,
        expectedStatus: row.task_status,
        expectedVersion: row.task_version,
        to: 'MERGED',
        actorRole: 'GITHUB_RECONCILER',
        actorId: 'github-reconciler',
        correlationId,
      });
      await this.database.query(
        `UPDATE pull_requests SET state = 'MERGED', updated_at = now()
         WHERE task_id = $1`,
        [row.task_id],
      );
    } else if (decision === 'MARK_CHANGES_REQUESTED') {
      await this.tasks.transition({
        taskId: row.task_id,
        expectedStatus: row.task_status,
        expectedVersion: row.task_version,
        to: 'CHANGES_REQUESTED',
        actorRole: 'GITHUB_RECONCILER',
        actorId: 'github-reconciler',
        correlationId,
      });
      if (external.state === 'CLOSED') {
        await this.database.query(
          `UPDATE pull_requests SET state = 'CLOSED', updated_at = now()
           WHERE task_id = $1`,
          [row.task_id],
        );
      }
    } else if (decision === 'MARK_PR_READY') {
      await this.tasks.transition({
        taskId: row.task_id,
        expectedStatus: 'CI',
        expectedVersion: row.task_version,
        to: 'PR_READY',
        actorRole: 'CI_RECONCILER',
        actorId: 'github-reconciler',
        correlationId,
      });
    } else if (decision === 'MARK_CI_FAILED') {
      await this.tasks.transition({
        taskId: row.task_id,
        expectedStatus: 'CI',
        expectedVersion: row.task_version,
        to: 'FAILED',
        actorRole: 'CI_RECONCILER',
        actorId: 'github-reconciler',
        correlationId,
        eventPayload: { failureClass: 'CI' },
      });
    }
    await this.database.query(
      `INSERT INTO reconciliation_actions
        (id, task_id, repository_id, action, idempotency_key, external_facts,
         result, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'github-reconciler')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        row.task_id,
        row.repository_id,
        decision,
        idempotencyKey,
        external,
        { previousStatus: row.task_status },
      ],
    );
  }
}
