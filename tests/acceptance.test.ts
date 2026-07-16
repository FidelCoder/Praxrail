import { describe, expect, it } from 'vitest';
import {
  acceptanceRunSchema,
  acceptanceStatus,
  RELEASE_ACCEPTANCE_SCENARIOS,
} from '../src/acceptance/acceptance-service.js';

function scenarios(status: 'PASSED' | 'FAILED' | 'OPERATOR_GATED') {
  return RELEASE_ACCEPTANCE_SCENARIOS.map((id) => ({
    id,
    status,
    evidenceIds: status === 'OPERATOR_GATED' ? [] : [`evidence:${id}`],
    notes: '',
  }));
}

describe('release acceptance evidence', () => {
  it('requires all fourteen unique scenarios', () => {
    expect(
      acceptanceRunSchema.safeParse({
        environment: 'sandbox',
        passNumber: 1,
        scenarios: scenarios('PASSED').slice(1),
      }).success,
    ).toBe(false);
  });

  it('cannot pass without owner signoff or while an operator gate remains', () => {
    expect(
      acceptanceStatus({
        environment: 'sandbox',
        passNumber: 1,
        scenarios: scenarios('PASSED'),
      }),
    ).toBe('OPERATOR_GATED');
    expect(
      acceptanceStatus({
        environment: 'sandbox',
        passNumber: 1,
        scenarios: scenarios('OPERATOR_GATED'),
        ownerSignoff: 'owner-42',
      }),
    ).toBe('OPERATOR_GATED');
  });

  it('passes only a fully evidenced, signed run and preserves failures', () => {
    expect(
      acceptanceStatus({
        environment: 'sandbox',
        passNumber: 2,
        scenarios: scenarios('PASSED'),
        ownerSignoff: 'owner-42',
      }),
    ).toBe('PASSED');
    expect(
      acceptanceStatus({
        environment: 'sandbox',
        passNumber: 2,
        scenarios: scenarios('FAILED'),
        ownerSignoff: 'owner-42',
      }),
    ).toBe('FAILED');
  });
});
