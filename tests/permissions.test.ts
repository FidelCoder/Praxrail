import { describe, expect, it } from 'vitest';
import { assertCapability } from '../src/security/permissions.js';

describe('role permissions', () => {
  it('allows only scoped role capabilities', () => {
    expect(() => assertCapability('PLANNER', 'TASK_REFINE')).not.toThrow();
    expect(() => assertCapability('PLANNER', 'TASK_APPROVE')).toThrow(/lacks/);
    expect(() => assertCapability('REVIEWER', 'TASK_BUILD_RESULT')).toThrow(
      /lacks/,
    );
    expect(() => assertCapability('OPERATOR', 'TASK_RECONCILE')).not.toThrow();
  });
});
