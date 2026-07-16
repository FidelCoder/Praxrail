import { describe, expect, it } from 'vitest';
import {
  approvalTokenMatches,
  digestApprovalToken,
  issueApprovalToken,
} from '../src/domain/approval.js';

describe('approval tokens', () => {
  it('issues high-entropy expiring tokens and stores only their digest', () => {
    const now = new Date('2026-07-16T12:00:00Z');
    const issued = issueApprovalToken(now, 60_000);
    expect(issued.rawToken.length).toBeGreaterThan(32);
    expect(issued.tokenDigest).toBe(digestApprovalToken(issued.rawToken));
    expect(issued.expiresAt.toISOString()).toBe('2026-07-16T12:01:00.000Z');
  });

  it('compares token digests without accepting different values', () => {
    const issued = issueApprovalToken();
    expect(approvalTokenMatches(issued.rawToken, issued.tokenDigest)).toBe(
      true,
    );
    expect(
      approvalTokenMatches(`${issued.rawToken}x`, issued.tokenDigest),
    ).toBe(false);
  });
});
