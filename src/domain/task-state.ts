import { DomainError } from './errors.js';
import { validateReadyContract, type TaskContract } from './task-contract.js';

export const TASK_STATUSES = [
  'INBOX',
  'REFINING',
  'BLOCKED',
  'READY',
  'BUILDING',
  'FAILED',
  'REVIEWING',
  'CHANGES_REQUESTED',
  'CI',
  'PR_READY',
  'AWAITING_APPROVAL',
  'MERGED',
  'DEPLOYED',
  'VERIFIED',
  'CANCELLED',
  'ABANDONED',
  'SUPERSEDED',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const transitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  INBOX: ['REFINING', 'CANCELLED', 'SUPERSEDED'],
  REFINING: ['BLOCKED', 'READY', 'CANCELLED', 'SUPERSEDED'],
  BLOCKED: ['REFINING', 'READY', 'CANCELLED', 'ABANDONED', 'SUPERSEDED'],
  READY: ['BUILDING', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
  BUILDING: ['REVIEWING', 'FAILED', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
  FAILED: ['READY', 'ABANDONED', 'CANCELLED', 'SUPERSEDED'],
  REVIEWING: ['CHANGES_REQUESTED', 'CI', 'FAILED', 'CANCELLED', 'SUPERSEDED'],
  CHANGES_REQUESTED: ['BUILDING', 'FAILED', 'CANCELLED', 'SUPERSEDED'],
  CI: ['PR_READY', 'CHANGES_REQUESTED', 'FAILED', 'CANCELLED', 'SUPERSEDED'],
  PR_READY: [
    'AWAITING_APPROVAL',
    'MERGED',
    'CHANGES_REQUESTED',
    'CANCELLED',
    'SUPERSEDED',
  ],
  AWAITING_APPROVAL: ['MERGED', 'CHANGES_REQUESTED', 'CANCELLED', 'SUPERSEDED'],
  MERGED: ['DEPLOYED', 'VERIFIED'],
  DEPLOYED: ['VERIFIED', 'FAILED'],
  VERIFIED: [],
  CANCELLED: [],
  ABANDONED: [],
  SUPERSEDED: [],
};

const actorsByTarget: Partial<Readonly<Record<TaskStatus, readonly string[]>>> =
  {
    READY: ['PLANNER', 'OPERATOR'],
    BUILDING: ['SCHEDULER', 'OPERATOR'],
    REVIEWING: ['BUILDER_WORKER', 'OPERATOR'],
    CI: ['REVIEWER', 'OPERATOR'],
    PR_READY: ['CI_RECONCILER', 'OPERATOR'],
    AWAITING_APPROVAL: ['RELEASE_MANAGER', 'OPERATOR'],
    MERGED: ['GITHUB_RECONCILER', 'OPERATOR'],
    DEPLOYED: ['RELEASE_MANAGER', 'OPERATOR'],
    VERIFIED: ['RELEASE_MANAGER', 'GITHUB_RECONCILER', 'OPERATOR'],
    SUPERSEDED: ['OPERATOR'],
  };

export interface TransitionInput {
  from: TaskStatus;
  to: TaskStatus;
  actorRole: string;
  contract?: TaskContract | Record<string, unknown> | null;
}

export function allowedTransitions(status: TaskStatus): readonly TaskStatus[] {
  return transitions[status];
}

export function assertTaskTransition(input: TransitionInput): void {
  if (!transitions[input.from].includes(input.to)) {
    throw new DomainError(
      `Task cannot transition from ${input.from} to ${input.to}`,
      'INVALID_TASK_TRANSITION',
    );
  }

  const actorRoles = actorsByTarget[input.to];
  if (actorRoles && !actorRoles.includes(input.actorRole)) {
    throw new DomainError(
      `${input.actorRole} cannot transition a task to ${input.to}`,
      'INVALID_TRANSITION_ACTOR',
    );
  }

  if (input.to === 'READY') {
    validateReadyContract(input.contract);
  }
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return transitions[status].length === 0;
}
