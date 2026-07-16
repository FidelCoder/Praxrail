import { z } from 'zod';

export const riskSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type Risk = z.infer<typeof riskSchema>;

export const approvalRequirementSchema = z.object({
  action: z.string().min(1).max(120),
  requiredRole: z.enum(['OWNER', 'SECURITY', 'RELEASE_MANAGER']),
  reason: z.string().min(1).max(1_000),
});

export const taskContractSchema = z
  .object({
    version: z.literal(1),
    projectId: z.uuid(),
    repositoryId: z.uuid(),
    title: z.string().trim().min(5).max(180),
    problem: z.string().trim().min(10).max(10_000),
    desiredOutcome: z.string().trim().min(10).max(10_000),
    acceptanceCriteria: z
      .array(z.string().trim().min(3).max(2_000))
      .min(1)
      .max(30),
    includedScope: z.array(z.string().trim().min(1).max(1_000)).min(1).max(30),
    excludedScope: z.array(z.string().trim().min(1).max(1_000)).max(30),
    dependencyTaskIds: z.array(z.uuid()).max(50),
    risk: riskSchema,
    verificationCommands: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(30),
    expectedArtifacts: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(30),
    budgetUsd: z.number().positive().max(10_000),
    maximumAttempts: z.number().int().min(1).max(10),
    mergePolicy: z.enum(['MANUAL', 'POLICY']),
    deploymentPolicy: z.enum(['NONE', 'STAGING', 'MANUAL_PRODUCTION']),
    approvalRequirements: z.array(approvalRequirementSchema).max(20),
  })
  .strict();

export type TaskContract = z.infer<typeof taskContractSchema>;

export const taskProposalSchema = taskContractSchema.partial().extend({
  version: z.literal(1),
  title: z.string().trim().min(5).max(180),
  problem: z.string().trim().min(10).max(10_000),
  desiredOutcome: z.string().trim().min(10).max(10_000),
});

export type TaskProposal = z.infer<typeof taskProposalSchema>;

export function validateReadyContract(value: unknown): TaskContract {
  return taskContractSchema.parse(value);
}
