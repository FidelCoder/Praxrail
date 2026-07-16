import type {
  AgentProvider,
  AgentProviderResult,
  AgentRequest,
} from '../../src/agents/provider.js';
import type {
  DeploymentAdapter,
  DeploymentEnvironment,
  HealthOutcome,
} from '../../src/deployment/deployment-service.js';
import type { NotificationGateway } from '../../src/notifications/notification-service.js';
import type {
  PullRequestGateway,
  PullRequestRecord,
} from '../../src/publishing/pull-request-gateway.js';
import type {
  ExternalPullRequestFacts,
  ReconciliationGateway,
} from '../../src/recovery/reconciliation-service.js';

export const FAILURE_SCENARIOS = [
  'TIMEOUT',
  'CRASH',
  'DUPLICATE_WEBHOOK',
  'API_RATE_LIMIT',
  'INVALID_SIGNATURE',
  'DATABASE_DISCONNECT',
  'DISK_PRESSURE',
  'CI_FAILURE',
  'REVIEW_REJECTION',
  'BUDGET_EXHAUSTION',
  'NOTIFICATION_FAILURE',
] as const;
export type FailureScenario = (typeof FAILURE_SCENARIOS)[number];

export const failureScenarioEvidence: Readonly<
  Record<FailureScenario, string>
> = {
  TIMEOUT: 'restricted runner and fake-agent timeout tests',
  CRASH: 'durable replay and idempotent fake side-effect tests',
  DUPLICATE_WEBHOOK: 'GitHub webhook replay integration test',
  API_RATE_LIMIT: 'bounded integration retry test',
  INVALID_SIGNATURE: 'GitHub and Telegram authentication tests',
  DATABASE_DISCONNECT: 'health fail-closed test',
  DISK_PRESSURE: 'disk pressure claim-gate test',
  CI_FAILURE: 'reconciliation decision-table test',
  REVIEW_REJECTION: 'review completion and bounded retry tests',
  BUDGET_EXHAUSTION: 'cost and retry policy tests',
  NOTIFICATION_FAILURE: 'outbox notification retry test',
};

export class InjectedFailure extends Error {
  constructor(readonly scenario: FailureScenario) {
    super(`Injected failure: ${scenario}`);
  }
}

export class FailurePlan {
  private readonly remaining = new Map<FailureScenario, number>();

  inject(scenario: FailureScenario, times = 1): this {
    this.remaining.set(scenario, times);
    return this;
  }

  hit(scenario: FailureScenario): void {
    const count = this.remaining.get(scenario) ?? 0;
    if (count <= 0) return;
    this.remaining.set(scenario, count - 1);
    throw new InjectedFailure(scenario);
  }
}

export class FakeAgentProvider implements AgentProvider {
  readonly calls: AgentRequest[] = [];

  constructor(
    private readonly responses: AgentProviderResult[],
    private readonly failures = new FailurePlan(),
  ) {}

  async run(request: AgentRequest): Promise<AgentProviderResult> {
    this.calls.push(request);
    this.failures.hit('TIMEOUT');
    this.failures.hit('CRASH');
    this.failures.hit('API_RATE_LIMIT');
    this.failures.hit('REVIEW_REJECTION');
    const response = this.responses.shift();
    if (!response) throw new Error('No fake agent response remains');
    return response;
  }
}

export class FakeNotificationGateway implements NotificationGateway {
  readonly deliveries = new Map<
    string,
    { destination: string; html: string }
  >();

  constructor(private readonly failures = new FailurePlan()) {}

  async send(input: {
    destination: string;
    html: string;
    idempotencyKey: string;
  }): Promise<{ deliveryId: string }> {
    this.failures.hit('NOTIFICATION_FAILURE');
    if (!this.deliveries.has(input.idempotencyKey)) {
      this.deliveries.set(input.idempotencyKey, {
        destination: input.destination,
        html: input.html,
      });
    }
    return { deliveryId: input.idempotencyKey };
  }
}

export class FakePullRequestGateway implements PullRequestGateway {
  readonly requests = new Map<string, PullRequestRecord>();

  constructor(private readonly failures = new FailurePlan()) {}

  async createOrUpdate(input: {
    repositoryFullName: string;
    branchName: string;
    defaultBranch: string;
    title: string;
    body: string;
  }): Promise<PullRequestRecord> {
    this.failures.hit('API_RATE_LIMIT');
    this.failures.hit('CRASH');
    const key = `${input.repositoryFullName}:${input.branchName}`;
    const prior = this.requests.get(key);
    if (prior) return prior;
    const record: PullRequestRecord = {
      id: this.requests.size + 1,
      number: this.requests.size + 1,
      url: `https://github.test/${input.repositoryFullName}/pull/${this.requests.size + 1}`,
      state: 'OPEN',
    };
    this.requests.set(key, record);
    return record;
  }
}

export class FakeReconciliationGateway implements ReconciliationGateway {
  constructor(
    private readonly facts: ExternalPullRequestFacts,
    private readonly failures = new FailurePlan(),
  ) {}

  async pullRequest(): Promise<ExternalPullRequestFacts> {
    this.failures.hit('API_RATE_LIMIT');
    this.failures.hit('CI_FAILURE');
    return this.facts;
  }
}

export class FakeDeploymentAdapter implements DeploymentAdapter {
  readonly name = 'fake';
  readonly sideEffects = new Map<string, string>();

  constructor(
    private readonly healthOutcome: HealthOutcome,
    private readonly failures = new FailurePlan(),
  ) {}

  async deploy(input: {
    environment: DeploymentEnvironment;
    commitSha: string;
    identity: string;
    idempotencyKey: string;
  }): Promise<{ externalId: string; evidence: Record<string, unknown> }> {
    this.failures.hit('CRASH');
    const externalId =
      this.sideEffects.get(input.idempotencyKey) ??
      `deployment-${this.sideEffects.size + 1}`;
    this.sideEffects.set(input.idempotencyKey, externalId);
    return { externalId, evidence: { commitSha: input.commitSha } };
  }

  async checkHealth(): Promise<{
    outcome: HealthOutcome;
    evidence: Record<string, unknown>;
  }> {
    return { outcome: this.healthOutcome, evidence: { checked: true } };
  }

  async rollback(input: {
    environment: DeploymentEnvironment;
    externalId: string;
    identity: string;
  }): Promise<{ externalId: string; evidence: Record<string, unknown> }> {
    return {
      externalId: `rollback-${input.externalId}`,
      evidence: { rolledBack: true },
    };
  }
}
