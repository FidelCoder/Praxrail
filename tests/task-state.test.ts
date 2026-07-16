import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  assertTaskTransition,
  isTerminalStatus,
  TASK_STATUSES,
  type TaskStatus,
} from '../src/domain/task-state.js';
import { taskContract } from './fixtures.js';

describe('task state machine', () => {
  const targetActors: Partial<Record<TaskStatus, string>> = {
    READY: 'PLANNER',
    BUILDING: 'SCHEDULER',
    REVIEWING: 'BUILDER_WORKER',
    CI: 'REVIEWER',
    PR_READY: 'CI_RECONCILER',
    AWAITING_APPROVAL: 'RELEASE_MANAGER',
    MERGED: 'GITHUB_RECONCILER',
    DEPLOYED: 'RELEASE_MANAGER',
    VERIFIED: 'GITHUB_RECONCILER',
  };

  it('defines every state and keeps terminal states closed', () => {
    for (const status of TASK_STATUSES)
      expect(allowedTransitions(status)).toBeDefined();
    expect(isTerminalStatus('VERIFIED')).toBe(true);
    expect(isTerminalStatus('READY')).toBe(false);
  });

  it('allows a planner to move a complete refining task to ready', () => {
    expect(() =>
      assertTaskTransition({
        from: 'REFINING',
        to: 'READY',
        actorRole: 'PLANNER',
        contract: taskContract(),
      }),
    ).not.toThrow();
  });

  it('accepts every declared transition with its authorized actor', () => {
    for (const from of TASK_STATUSES) {
      for (const to of allowedTransitions(from)) {
        expect(() =>
          assertTaskTransition({
            from,
            to,
            actorRole: targetActors[to] ?? 'OPERATOR',
            ...(to === 'READY' ? { contract: taskContract() } : {}),
          }),
        ).not.toThrow();
      }
    }
  });

  it('rejects every transition not declared by the state table', () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        if (allowedTransitions(from).includes(to)) continue;
        expect(() =>
          assertTaskTransition({
            from,
            to,
            actorRole: 'OPERATOR',
            ...(to === 'READY' ? { contract: taskContract() } : {}),
          }),
        ).toThrow(/cannot transition/);
      }
    }
  });

  it('rejects incomplete ready contracts, invalid transitions, and wrong actors', () => {
    expect(() =>
      assertTaskTransition({
        from: 'REFINING',
        to: 'READY',
        actorRole: 'PLANNER',
        contract: null,
      }),
    ).toThrow();
    expect(() =>
      assertTaskTransition({
        from: 'INBOX',
        to: 'MERGED',
        actorRole: 'OPERATOR',
      }),
    ).toThrow(/cannot transition/);
    expect(() =>
      assertTaskTransition({
        from: 'READY',
        to: 'BUILDING',
        actorRole: 'PLANNER',
        contract: taskContract(),
      }),
    ).toThrow(/cannot transition/);
  });
});
