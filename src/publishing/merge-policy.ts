import type { Risk } from '../domain/task-contract.js';

export interface MergePolicyInput {
  risk: Risk;
  requiredChecksPassed: boolean;
  reviewedSha: string;
  headSha: string;
  unresolvedFindings: number;
  requiredApprovals: number;
  grantedApprovals: number;
  branchProtectionSatisfied: boolean;
  withinBudget: boolean;
}

export interface MergePolicyDecision {
  eligible: boolean;
  nextStatus: 'PR_READY' | 'AWAITING_APPROVAL';
  reasons: string[];
  automaticMergeAllowed: false;
}

export function evaluateMergePolicy(
  input: MergePolicyInput,
): MergePolicyDecision {
  const reasons: string[] = [];
  if (!input.requiredChecksPassed)
    reasons.push('Required checks are not passing');
  if (input.reviewedSha !== input.headSha) {
    reasons.push('Independent review does not cover the current head SHA');
  }
  if (input.unresolvedFindings > 0) {
    reasons.push('Unresolved review findings remain');
  }
  if (input.grantedApprovals < input.requiredApprovals) {
    reasons.push('Required human approvals are missing');
  }
  if (!input.branchProtectionSatisfied) {
    reasons.push('GitHub branch protection is not satisfied');
  }
  if (!input.withinBudget) reasons.push('Task or daily budget is exhausted');
  if (input.risk === 'HIGH' && input.requiredApprovals === 0) {
    reasons.push('High-risk work requires an explicit approval');
  }
  return {
    eligible: reasons.length === 0,
    nextStatus: reasons.length === 0 ? 'AWAITING_APPROVAL' : 'PR_READY',
    reasons,
    automaticMergeAllowed: false,
  };
}
