import { AuthorizationError } from '../domain/errors.js';

export const ACTOR_ROLES = [
  'OWNER',
  'PLANNER',
  'SCHEDULER',
  'BUILDER_WORKER',
  'REVIEWER',
  'CI_RECONCILER',
  'GITHUB_RECONCILER',
  'RELEASE_MANAGER',
  'REPORTER',
  'OPERATOR',
] as const;

export type ActorRole = (typeof ACTOR_ROLES)[number];

export const CAPABILITIES = [
  'TASK_CREATE',
  'TASK_REFINE',
  'TASK_PRIORITIZE',
  'TASK_PAUSE',
  'TASK_APPROVE',
  'TASK_CLAIM',
  'TASK_BUILD_RESULT',
  'TASK_REVIEW_RESULT',
  'TASK_RECONCILE',
  'REPORT_READ',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const permissions: Readonly<Record<ActorRole, readonly Capability[]>> = {
  OWNER: [
    'TASK_CREATE',
    'TASK_PRIORITIZE',
    'TASK_PAUSE',
    'TASK_APPROVE',
    'REPORT_READ',
  ],
  PLANNER: ['TASK_CREATE', 'TASK_REFINE'],
  SCHEDULER: ['TASK_CLAIM'],
  BUILDER_WORKER: ['TASK_BUILD_RESULT'],
  REVIEWER: ['TASK_REVIEW_RESULT'],
  CI_RECONCILER: ['TASK_RECONCILE'],
  GITHUB_RECONCILER: ['TASK_RECONCILE'],
  RELEASE_MANAGER: ['TASK_RECONCILE'],
  REPORTER: ['REPORT_READ'],
  OPERATOR: [...CAPABILITIES],
};

export function assertCapability(
  role: ActorRole,
  capability: Capability,
): void {
  if (!permissions[role].includes(capability)) {
    throw new AuthorizationError(`${role} lacks ${capability}`);
  }
}
