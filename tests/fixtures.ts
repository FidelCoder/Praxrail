import type { AppConfig } from '../src/config.js';
import type { TaskContract } from '../src/domain/task-contract.js';

export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const REPOSITORY_ID = '22222222-2222-4222-8222-222222222222';

export function taskContract(
  overrides: Partial<TaskContract> = {},
): TaskContract {
  return {
    version: 1,
    projectId: PROJECT_ID,
    repositoryId: REPOSITORY_ID,
    title: 'Implement a verified change',
    problem:
      'The current behavior does not meet the requested product outcome.',
    desiredOutcome:
      'The requested behavior is implemented and verified by tests.',
    acceptanceCriteria: ['The requested behavior works', 'Verification passes'],
    includedScope: ['The requested module'],
    excludedScope: ['Automatic merge'],
    dependencyTaskIds: [],
    risk: 'LOW',
    verificationCommands: ['pnpm test'],
    expectedArtifacts: ['Source changes', 'Verification evidence'],
    budgetUsd: 5,
    maximumAttempts: 3,
    mergePolicy: 'MANUAL',
    deploymentPolicy: 'NONE',
    approvalRequirements: [],
    ...overrides,
  };
}

export function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    environment: 'test',
    host: '127.0.0.1',
    port: 3000,
    logLevel: 'silent',
    api: {
      enabled: false,
      bootstrapActorId: 'local-owner',
      bootstrapRole: 'OWNER',
    },
    database: {
      url: 'postgres://praxrail:praxrail@localhost:5433/praxrail',
      ssl: false,
      migrationsDir: '/tmp/migrations',
    },
    owner: { timezone: 'Africa/Nairobi', dailyReportTime: '18:00' },
    budget: { taskUsd: 5, dailyUsd: 25, monthlyUsd: 300 },
    attempts: { build: 3, review: 2 },
    jobs: { concurrency: 4, retryLimit: 3, retryDelaySeconds: 5 },
    paths: {
      workspaceRoot: '/tmp/praxrail/workspaces',
      repositoryRoot: '/tmp/praxrail/repos',
    },
    telegram: {
      enabled: false,
      allowedUserIds: new Set(),
      allowedChatIds: new Set(),
    },
    github: {
      enabled: false,
      allowedRepositories: new Set(),
    },
    codex: { enabled: false, timeoutMs: 1_200_000 },
    telemetry: { enabled: false, serviceName: 'praxrail-test' },
    ...overrides,
  };
}
