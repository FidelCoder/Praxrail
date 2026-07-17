import { z } from 'zod';

export const ACTOR_ROLES = [
  'OWNER',
  'DEVELOPER',
  'PLANNER',
  'SCHEDULER',
  'WORKER',
  'BUILDER_WORKER',
  'REVIEWER',
  'CI_RECONCILER',
  'GITHUB_RECONCILER',
  'RELEASE_MANAGER',
  'REPORTER',
  'OPERATOR',
] as const;
export const actorRoleSchema = z.enum(ACTOR_ROLES);
export type ActorRole = z.infer<typeof actorRoleSchema>;

export const CAPABILITIES = [
  'RUNTIME_READ',
  'TASK_READ',
  'TASK_CREATE',
  'TASK_REFINE',
  'TASK_PRIORITIZE',
  'TASK_PAUSE',
  'TASK_APPROVE',
  'TASK_CLAIM',
  'TASK_BUILD_RESULT',
  'TASK_REVIEW_RESULT',
  'TASK_RECONCILE',
  'WORKER_REGISTER',
  'WORKER_HEARTBEAT',
  'WORKSPACE_ATTACH',
  'WORKSPACE_RETURN',
  'WORKSPACE_RECOVER',
  'REPORT_READ',
] as const;
export const capabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof capabilitySchema>;

export const apiActorSchema = z
  .object({
    identityId: z.uuid(),
    tokenId: z.uuid(),
    actorId: z.string().min(1).max(200),
    role: actorRoleSchema,
    projectIds: z.array(z.uuid()).max(500),
  })
  .strict();
export type ApiActor = z.infer<typeof apiActorSchema>;
