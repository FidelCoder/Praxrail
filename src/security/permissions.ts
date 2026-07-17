import { CAPABILITIES, type ActorRole, type Capability } from '@praxrail/core';
import { AuthorizationError } from '../domain/errors.js';

export {
  ACTOR_ROLES,
  CAPABILITIES,
  type ActorRole,
  type Capability,
} from '@praxrail/core';

const permissions: Readonly<Record<ActorRole, readonly Capability[]>> = {
  OWNER: [
    'RUNTIME_READ',
    'TASK_READ',
    'TASK_CREATE',
    'TASK_PRIORITIZE',
    'TASK_PAUSE',
    'TASK_APPROVE',
    'WORKSPACE_ATTACH',
    'WORKSPACE_RETURN',
    'REPORT_READ',
  ],
  DEVELOPER: [
    'RUNTIME_READ',
    'TASK_READ',
    'TASK_CREATE',
    'TASK_REFINE',
    'TASK_PRIORITIZE',
    'TASK_PAUSE',
    'WORKSPACE_ATTACH',
    'WORKSPACE_RETURN',
  ],
  PLANNER: ['TASK_READ', 'TASK_CREATE', 'TASK_REFINE'],
  SCHEDULER: ['RUNTIME_READ', 'TASK_READ', 'TASK_CLAIM'],
  WORKER: [
    'RUNTIME_READ',
    'TASK_READ',
    'TASK_CLAIM',
    'TASK_BUILD_RESULT',
    'WORKER_REGISTER',
    'WORKER_HEARTBEAT',
  ],
  BUILDER_WORKER: ['TASK_READ', 'TASK_BUILD_RESULT', 'WORKER_HEARTBEAT'],
  REVIEWER: ['TASK_READ', 'TASK_REVIEW_RESULT'],
  CI_RECONCILER: ['TASK_READ', 'TASK_RECONCILE'],
  GITHUB_RECONCILER: ['TASK_READ', 'TASK_RECONCILE'],
  RELEASE_MANAGER: ['TASK_READ', 'TASK_RECONCILE'],
  REPORTER: ['TASK_READ', 'REPORT_READ'],
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
