import type { Risk } from '../domain/task-contract.js';

export interface AutoMergeCalibrationInput {
  enabled: boolean;
  killSwitchActive: boolean;
  ownerApproved: boolean;
  taskClass: string;
  eligibleTaskClasses: readonly string[];
  sampleSize: number;
  minimumSampleSize: number;
  rollbackRate: number;
  maximumRollbackRate: number;
  risk: Risk;
  requiredChecksPassed: boolean;
  reviewPassed: boolean;
  headMatchesReview: boolean;
}

export function evaluateAutoMergeCalibration(
  input: AutoMergeCalibrationInput,
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.enabled) reasons.push('Auto-merge is disabled');
  if (input.killSwitchActive)
    reasons.push('The auto-merge kill switch is active');
  if (!input.ownerApproved) reasons.push('Owner approval is missing');
  if (!input.eligibleTaskClasses.includes(input.taskClass)) {
    reasons.push('Task class is not calibrated for auto-merge');
  }
  if (input.sampleSize < input.minimumSampleSize) {
    reasons.push('Calibration sample size is too small');
  }
  if (
    input.rollbackRate < 0 ||
    input.rollbackRate > 1 ||
    input.rollbackRate > input.maximumRollbackRate
  ) {
    reasons.push('Observed rollback rate exceeds policy');
  }
  if (input.risk !== 'LOW') reasons.push('Only low-risk tasks are eligible');
  if (!input.requiredChecksPassed)
    reasons.push('Required checks are not passing');
  if (!input.reviewPassed) reasons.push('Independent review is not passing');
  if (!input.headMatchesReview)
    reasons.push('Review does not cover the current head');
  return { allowed: reasons.length === 0, reasons };
}
