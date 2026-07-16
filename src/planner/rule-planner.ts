import type { AppConfig } from '../config.js';
import type {
  Risk,
  TaskContract,
  TaskProposal,
} from '../domain/task-contract.js';
import type { ManagedRepository } from './repository-catalog.js';

export type PlanningResult =
  | { kind: 'READY'; proposal: TaskProposal; contract: TaskContract }
  | { kind: 'BLOCKED'; proposal: TaskProposal; question: string };

function classifyRisk(text: string): Risk {
  if (
    /\b(auth(?:entication|orization)?|billing|payment|cryptograph|secret|migration|database schema|production|infrastructure|legal|compliance)\b/i.test(
      text,
    )
  ) {
    return 'HIGH';
  }
  if (
    /\b(feature|api|refactor|performance|integration|user-facing)\b/i.test(text)
  ) {
    return 'MEDIUM';
  }
  return 'LOW';
}

function titleFrom(text: string): string {
  const normalized = text
    .replace(/^\/task\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = normalized.split(/[.!?\n]/, 1)[0]?.trim() ?? '';
  const title = sentence.slice(0, 180);
  return title.length >= 5 ? title : 'Refine requested engineering change';
}

function selectRepository(
  text: string,
  repositories: readonly ManagedRepository[],
): ManagedRepository | null {
  const normalized = text.toLowerCase();
  const exact = repositories.filter((repository) =>
    normalized.includes(repository.fullName.toLowerCase()),
  );
  if (exact.length === 1) return exact[0] ?? null;

  const profile = repositories.filter((repository) => {
    const workerProfile = repository.workerProfile.toLowerCase();
    return (
      normalized.includes(workerProfile) ||
      normalized.includes(workerProfile.replace(' worker', ''))
    );
  });
  return profile.length === 1 ? (profile[0] ?? null) : null;
}

export class RulePlanner {
  constructor(private readonly config: AppConfig) {}

  plan(
    text: string,
    repositories: readonly ManagedRepository[],
  ): PlanningResult {
    const trimmed = text.trim();
    const title = titleFrom(trimmed);
    const problem = `The owner requested the following engineering change: ${trimmed}`;
    const desiredOutcome = `Deliver the requested outcome for "${title}" with repository verification passing.`;
    const repository = selectRepository(trimmed, repositories);
    const proposal: TaskProposal = {
      version: 1,
      title,
      problem,
      desiredOutcome,
    };

    if (!repository) {
      return {
        kind: 'BLOCKED',
        proposal,
        question:
          repositories.length === 0
            ? 'Which approved repository should handle this task? No repository is enabled yet.'
            : `Which approved repository should handle this task: ${repositories
                .map((entry) => entry.fullName)
                .join(', ')}?`,
      };
    }

    const risk = classifyRisk(trimmed);
    const contract: TaskContract = {
      version: 1,
      projectId: repository.projectId,
      repositoryId: repository.id,
      title,
      problem,
      desiredOutcome,
      acceptanceCriteria: [
        `The requested behavior described in "${title}" is implemented.`,
        'All configured repository verification commands pass.',
        'No unrelated behavior or files are changed.',
      ],
      includedScope: [trimmed],
      excludedScope: [
        'Unrequested product behavior',
        'Automatic merge',
        'Production deployment',
      ],
      dependencyTaskIds: [],
      risk,
      verificationCommands:
        repository.verificationCommands.length > 0
          ? repository.verificationCommands
          : ['Repository onboarding must define verification commands'],
      expectedArtifacts: [
        'Source changes',
        'Verification evidence',
        'Reviewed pull request',
      ],
      budgetUsd: this.config.budget.taskUsd,
      maximumAttempts: this.config.attempts.build,
      mergePolicy: 'MANUAL',
      deploymentPolicy: 'NONE',
      approvalRequirements:
        risk === 'HIGH'
          ? [
              {
                action: 'HIGH_RISK_CHANGE',
                requiredRole: 'OWNER',
                reason: 'High-risk changes require explicit owner approval.',
              },
            ]
          : [],
    };
    return { kind: 'READY', proposal, contract };
  }
}
