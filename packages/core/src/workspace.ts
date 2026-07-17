import { z } from 'zod';

export const workspaceOwnershipStates = [
  'AGENT_OWNED',
  'PAUSING',
  'HUMAN_OWNED',
  'RETURNING',
  'RECOVERY_REQUIRED',
] as const;
export const workspaceOwnershipStateSchema = z.enum(workspaceOwnershipStates);
export type WorkspaceOwnershipState = z.infer<
  typeof workspaceOwnershipStateSchema
>;

const transitions: Readonly<
  Record<WorkspaceOwnershipState, readonly WorkspaceOwnershipState[]>
> = {
  AGENT_OWNED: ['PAUSING', 'RECOVERY_REQUIRED'],
  PAUSING: ['HUMAN_OWNED', 'AGENT_OWNED', 'RECOVERY_REQUIRED'],
  HUMAN_OWNED: ['RETURNING', 'RECOVERY_REQUIRED'],
  RETURNING: ['AGENT_OWNED', 'HUMAN_OWNED', 'RECOVERY_REQUIRED'],
  RECOVERY_REQUIRED: ['HUMAN_OWNED', 'RETURNING'],
};

export function assertWorkspaceOwnershipTransition(
  from: WorkspaceOwnershipState,
  to: WorkspaceOwnershipState,
): void {
  if (!transitions[from].includes(to)) {
    throw new Error(`Workspace cannot transition from ${from} to ${to}`);
  }
}

export const workspaceOwnershipSchema = z
  .object({
    taskId: z.uuid(),
    repositoryId: z.uuid(),
    gitRefId: z.uuid().nullable(),
    assignmentId: z.uuid().nullable(),
    state: workspaceOwnershipStateSchema,
    ownerActorId: z.string().min(1).max(200).nullable(),
    workerId: z.uuid().nullable(),
    fencingToken: z.string().regex(/^\d+$/),
    leaseExpiresAt: z.iso.datetime(),
    reason: z.string().max(1_000).nullable(),
  })
  .strict();
export type WorkspaceOwnership = z.infer<typeof workspaceOwnershipSchema>;

export const workspaceActionSchema = z
  .object({
    reason: z.string().trim().min(5).max(1_000),
    leaseMilliseconds: z
      .number()
      .int()
      .min(30_000)
      .max(8 * 60 * 60_000),
    fencingToken: z.string().regex(/^\d+$/).optional(),
  })
  .strict();
