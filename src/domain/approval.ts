import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const approvalActionSchema = z.enum([
  'TASK_READY',
  'BUDGET_INCREASE',
  'HIGH_RISK_CHANGE',
  'PULL_REQUEST_MERGE',
  'PRODUCTION_DEPLOYMENT',
]);

export type ApprovalAction = z.infer<typeof approvalActionSchema>;

export interface ApprovalToken {
  rawToken: string;
  tokenDigest: string;
  expiresAt: Date;
}

export function digestApprovalToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function issueApprovalToken(
  now = new Date(),
  lifetimeMilliseconds = 15 * 60 * 1_000,
): ApprovalToken {
  const rawToken = randomBytes(32).toString('base64url');
  return {
    rawToken,
    tokenDigest: digestApprovalToken(rawToken),
    expiresAt: new Date(now.getTime() + lifetimeMilliseconds),
  };
}

export function approvalTokenMatches(
  rawToken: string,
  expectedDigest: string,
): boolean {
  const actual = Buffer.from(digestApprovalToken(rawToken), 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
