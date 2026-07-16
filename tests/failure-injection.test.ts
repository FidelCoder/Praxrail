import { describe, expect, it } from 'vitest';
import {
  FAILURE_SCENARIOS,
  FailurePlan,
  FakeAgentProvider,
  FakeDeploymentAdapter,
  FakeNotificationGateway,
  FakePullRequestGateway,
  failureScenarioEvidence,
} from './harness/failure-injection.js';

describe('deterministic failure-injection harness', () => {
  it('maps every required failure scenario to executable evidence', () => {
    expect(Object.keys(failureScenarioEvidence).sort()).toEqual(
      [...FAILURE_SCENARIOS].sort(),
    );
  });

  it('consumes an injected failure exactly the configured number of times', () => {
    const plan = new FailurePlan().inject('API_RATE_LIMIT', 2);
    expect(() => plan.hit('API_RATE_LIMIT')).toThrow(/API_RATE_LIMIT/);
    expect(() => plan.hit('API_RATE_LIMIT')).toThrow(/API_RATE_LIMIT/);
    expect(() => plan.hit('API_RATE_LIMIT')).not.toThrow();
  });

  it('proves pull request and notification side effects remain singular on replay', async () => {
    const pulls = new FakePullRequestGateway();
    const request = {
      repositoryFullName: 'fidelcoder/praxrail',
      branchName: 'praxrail/pxr-1',
      defaultBranch: 'main',
      title: 'PXR-1: test',
      body: 'evidence',
    };
    const first = await pulls.createOrUpdate(request);
    expect(await pulls.createOrUpdate(request)).toEqual(first);
    expect(pulls.requests.size).toBe(1);

    const notifications = new FakeNotificationGateway();
    const notification = {
      destination: '42',
      html: '<b>PXR-1</b>',
      idempotencyKey: 'telegram:pxr-1:accepted',
    };
    await notifications.send(notification);
    await notifications.send(notification);
    expect(notifications.deliveries.size).toBe(1);
  });

  it('injects adapter failure before side effects and succeeds on bounded retry', async () => {
    const failures = new FailurePlan().inject('CRASH');
    const deployment = new FakeDeploymentAdapter('PASSED', failures);
    const input = {
      environment: 'STAGING' as const,
      commitSha: 'a'.repeat(40),
      identity: 'staging:fixture',
      idempotencyKey: 'deploy:pxr-1',
    };
    await expect(deployment.deploy(input)).rejects.toThrow(/CRASH/);
    await expect(deployment.deploy(input)).resolves.toMatchObject({
      externalId: 'deployment-1',
    });
    await expect(deployment.deploy(input)).resolves.toMatchObject({
      externalId: 'deployment-1',
    });
    expect(deployment.sideEffects.size).toBe(1);
  });

  it('separates fake builder and reviewer requests without live credentials', async () => {
    const provider = new FakeAgentProvider([
      {
        threadId: 'thread-1',
        finalResponse: '{}',
        toolActions: [],
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningTokens: 0,
        },
      },
    ]);
    await provider.run({
      role: 'REVIEWER',
      prompt: 'review fixture',
      outputSchema: {},
      workingDirectory: '/tmp/fixture',
      model: 'fake',
      timeoutMs: 1_000,
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.role).toBe('REVIEWER');
  });
});
