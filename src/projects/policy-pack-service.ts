import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../persistence/database.js';

export const projectPolicyPackSchema = z
  .object({
    version: z.literal(1),
    repositoryIdentities: z
      .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
      .min(1),
    workerPool: z.string().min(1).max(100),
    portfolioBudgetUsd: z.number().positive(),
    taskBudgetUsd: z.number().positive(),
    allowedTaskClasses: z.array(z.string().min(1).max(100)).min(1),
    autoMergeEnabled: z.literal(false).default(false),
    productionDeploymentEnabled: z.literal(false).default(false),
  })
  .strict()
  .refine((policy) => policy.taskBudgetUsd <= policy.portfolioBudgetUsd, {
    message: 'Task budget cannot exceed the portfolio budget',
  });

export type ProjectPolicyPack = z.infer<typeof projectPolicyPackSchema>;

export class PolicyPackService {
  constructor(private readonly database: Database) {}

  async create(input: {
    projectId: string;
    version: number;
    policy: ProjectPolicyPack;
  }): Promise<string> {
    const policy = projectPolicyPackSchema.parse(input.policy);
    const id = randomUUID();
    await this.database.query(
      `INSERT INTO project_policy_packs
        (id, project_id, version, policy, active)
       VALUES ($1, $2, $3, $4, false)`,
      [id, input.projectId, input.version, policy],
    );
    return id;
  }

  async activate(input: {
    projectId: string;
    policyPackId: string;
    approvedBy: string;
  }): Promise<void> {
    if (!input.approvedBy.trim()) {
      throw new Error('Policy activation requires an owner');
    }
    await this.database.transaction(async (client) => {
      const selected = await client.query(
        `SELECT 1 FROM project_policy_packs
         WHERE id = $1 AND project_id = $2 FOR UPDATE`,
        [input.policyPackId, input.projectId],
      );
      if (selected.rowCount !== 1) throw new Error('Policy pack was not found');
      await client.query(
        `UPDATE project_policy_packs SET active = false
         WHERE project_id = $1 AND active = true`,
        [input.projectId],
      );
      await client.query(
        `UPDATE project_policy_packs SET active = true, approved_by = $3
         WHERE id = $1 AND project_id = $2`,
        [input.policyPackId, input.projectId, input.approvedBy],
      );
    });
  }
}
