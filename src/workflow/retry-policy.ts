import { createHash } from 'node:crypto';
import { z } from 'zod';

export const failureClassSchema = z.enum([
  'BUILDER',
  'VERIFICATION',
  'REVIEW',
  'CI',
  'TRANSIENT_INTEGRATION',
  'POLICY',
  'BUDGET',
  'INFRASTRUCTURE',
]);
export type FailureClass = z.infer<typeof failureClassSchema>;

export interface RetryInput {
  failureClass: FailureClass;
  attempts: number;
  reviewCycles: number;
  maximumAttempts: number;
  maximumReviewCycles: number;
  taskSpentUsd: number;
  taskBudgetUsd: number;
  dailySpentUsd: number;
  dailyBudgetUsd: number;
  diffDigest: string;
  errorText: string;
  previousDiffDigests: string[];
  previousErrorFingerprints: string[];
}

export type RetryDecision =
  | { action: 'RETRY'; reason: string; errorFingerprint: string }
  | { action: 'BLOCK'; reason: string; errorFingerprint: string }
  | { action: 'FAIL'; reason: string; errorFingerprint: string };

export function errorFingerprint(errorText: string): string {
  const normalized = errorText
    .toLowerCase()
    .replace(/[0-9a-f]{7,64}/g, '<sha>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}

export function decideRetry(input: RetryInput): RetryDecision {
  failureClassSchema.parse(input.failureClass);
  const fingerprint = errorFingerprint(input.errorText);
  if (
    input.taskSpentUsd >= input.taskBudgetUsd ||
    input.dailySpentUsd >= input.dailyBudgetUsd ||
    input.failureClass === 'BUDGET'
  ) {
    return {
      action: 'BLOCK',
      reason: 'Model budget is exhausted and requires an explicit increase',
      errorFingerprint: fingerprint,
    };
  }
  if (input.failureClass === 'POLICY') {
    return {
      action: 'BLOCK',
      reason: 'Policy failures require an authorized policy change',
      errorFingerprint: fingerprint,
    };
  }
  const repeatedDiff = input.previousDiffDigests.includes(input.diffDigest);
  const repeatedError =
    input.previousErrorFingerprints.filter((value) => value === fingerprint)
      .length >= 1;
  if (repeatedDiff && repeatedError) {
    return {
      action: 'FAIL',
      reason: 'No-progress loop detected from repeated diff and failure',
      errorFingerprint: fingerprint,
    };
  }
  if (input.attempts >= input.maximumAttempts) {
    return {
      action: 'FAIL',
      reason: 'Maximum build attempts exhausted',
      errorFingerprint: fingerprint,
    };
  }
  if (
    input.failureClass === 'REVIEW' &&
    input.reviewCycles >= input.maximumReviewCycles
  ) {
    return {
      action: 'FAIL',
      reason: 'Maximum review repair cycles exhausted',
      errorFingerprint: fingerprint,
    };
  }
  return {
    action: 'RETRY',
    reason:
      input.failureClass === 'TRANSIENT_INTEGRATION' ||
      input.failureClass === 'INFRASTRUCTURE'
        ? 'Retry transient failure with bounded backoff'
        : 'Start a bounded repair attempt with actionable evidence',
    errorFingerprint: fingerprint,
  };
}
