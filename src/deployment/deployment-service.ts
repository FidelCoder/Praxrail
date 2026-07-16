import { randomUUID } from 'node:crypto';
import type { Database } from '../persistence/database.js';

export type DeploymentEnvironment = 'STAGING' | 'PRODUCTION';
export type HealthOutcome = 'PASSED' | 'CONCLUSIVE_FAILURE' | 'INCONCLUSIVE';

export interface DeploymentAdapter {
  readonly name: string;
  deploy(input: {
    environment: DeploymentEnvironment;
    commitSha: string;
    identity: string;
    idempotencyKey: string;
  }): Promise<{ externalId: string; evidence: Record<string, unknown> }>;
  checkHealth(input: {
    environment: DeploymentEnvironment;
    externalId: string;
  }): Promise<{ outcome: HealthOutcome; evidence: Record<string, unknown> }>;
  rollback(input: {
    environment: DeploymentEnvironment;
    externalId: string;
    identity: string;
  }): Promise<{ externalId: string; evidence: Record<string, unknown> }>;
}

interface DeploymentRow {
  id: string;
  external_id: string | null;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK';
}

export class DeploymentService {
  constructor(
    private readonly database: Database,
    private readonly adapter: DeploymentAdapter,
  ) {}

  async deploy(input: {
    taskId: string;
    commitSha: string;
    environment: DeploymentEnvironment;
    identity: string;
    idempotencyKey: string;
    approvalId?: string;
    windowStart?: Date;
    windowEnd?: Date;
    now?: Date;
  }): Promise<{
    deploymentId: string;
    status: DeploymentRow['status'];
    replayed: boolean;
  }> {
    const existing = await this.database.query<DeploymentRow>(
      `SELECT id, external_id, status FROM deployments
       WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    const prior = existing.rows[0];
    if (prior) {
      return {
        deploymentId: prior.id,
        status: prior.status,
        replayed: true,
      };
    }
    if (input.environment === 'PRODUCTION') {
      await this.assertProductionGate(input);
    }
    const deploymentId = randomUUID();
    await this.database.query(
      `INSERT INTO deployments
        (id, task_id, environment, status, commit_sha, adapter, approval_id,
         idempotency_key)
       VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7)`,
      [
        deploymentId,
        input.taskId,
        input.environment,
        input.commitSha,
        this.adapter.name,
        input.approvalId ?? null,
        input.idempotencyKey,
      ],
    );
    try {
      const deployed = await this.adapter.deploy({
        environment: input.environment,
        commitSha: input.commitSha,
        identity: input.identity,
        idempotencyKey: input.idempotencyKey,
      });
      await this.database.query(
        `UPDATE deployments SET status = 'RUNNING', external_id = $2,
           evidence = $3 WHERE id = $1`,
        [deploymentId, deployed.externalId, deployed.evidence],
      );
      const health = await this.adapter.checkHealth({
        environment: input.environment,
        externalId: deployed.externalId,
      });
      if (health.outcome === 'PASSED') {
        await this.database.query(
          `UPDATE deployments SET status = 'SUCCEEDED', health_evidence = $2,
             completed_at = now() WHERE id = $1`,
          [deploymentId, health.evidence],
        );
        return { deploymentId, status: 'SUCCEEDED', replayed: false };
      }
      if (health.outcome === 'CONCLUSIVE_FAILURE') {
        const rollback = await this.adapter.rollback({
          environment: input.environment,
          externalId: deployed.externalId,
          identity: input.identity,
        });
        await this.database.query(
          `UPDATE deployments SET status = 'ROLLED_BACK',
             health_evidence = $2, rollback_external_id = $3,
             evidence = evidence || $4::jsonb, completed_at = now()
           WHERE id = $1`,
          [
            deploymentId,
            health.evidence,
            rollback.externalId,
            { rollback: rollback.evidence },
          ],
        );
        await this.createIncident(input.taskId, deploymentId, health.evidence);
        return { deploymentId, status: 'ROLLED_BACK', replayed: false };
      }
      await this.database.query(
        `UPDATE deployments SET status = 'FAILED', health_evidence = $2,
           completed_at = now() WHERE id = $1`,
        [deploymentId, health.evidence],
      );
      await this.createIncident(input.taskId, deploymentId, health.evidence);
      return { deploymentId, status: 'FAILED', replayed: false };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 1_000)
          : 'Deployment failed';
      await this.database.query(
        `UPDATE deployments SET status = 'FAILED',
           health_evidence = $2, completed_at = now() WHERE id = $1`,
        [deploymentId, { error: message }],
      );
      await this.createIncident(input.taskId, deploymentId, { error: message });
      throw error;
    }
  }

  private async assertProductionGate(input: {
    taskId: string;
    identity: string;
    approvalId?: string;
    windowStart?: Date;
    windowEnd?: Date;
    now?: Date;
  }): Promise<void> {
    if (!input.identity.startsWith('production:')) {
      throw new Error('Production deployment requires a production identity');
    }
    if (!input.approvalId) {
      throw new Error('Production deployment requires an approval');
    }
    const now = input.now ?? new Date();
    if (
      !input.windowStart ||
      !input.windowEnd ||
      now < input.windowStart ||
      now >= input.windowEnd
    ) {
      throw new Error(
        'Production deployment is outside the approved change window',
      );
    }
    const approval = await this.database.query<{
      status: string;
      action: string;
      expires_at: Date;
    }>(
      `SELECT status, action, expires_at FROM approvals
       WHERE id = $1 AND task_id = $2`,
      [input.approvalId, input.taskId],
    );
    const gate = approval.rows[0];
    if (
      gate?.status !== 'APPROVED' ||
      gate.action !== 'PRODUCTION_DEPLOYMENT' ||
      gate.expires_at <= now
    ) {
      throw new Error('Production approval is absent, invalid, or expired');
    }
  }

  private async createIncident(
    taskId: string,
    deploymentId: string,
    evidence: Record<string, unknown>,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO incidents
        (id, task_id, deployment_id, severity, title, evidence)
       VALUES ($1, $2, $3, 'HIGH', 'Deployment health gate failed', $4)`,
      [randomUUID(), taskId, deploymentId, evidence],
    );
  }
}
