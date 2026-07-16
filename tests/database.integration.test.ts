import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { BuilderService } from '../src/agents/builder-service.js';
import {
  AcceptanceService,
  RELEASE_ACCEPTANCE_SCENARIOS,
} from '../src/acceptance/acceptance-service.js';
import type { AgentProvider } from '../src/agents/provider.js';
import { ReviewService } from '../src/agents/review-service.js';
import { RestrictedRunner } from '../src/execution/restricted-runner.js';
import { GitHubWebhookService } from '../src/integrations/github/webhook-service.js';
import { EmailIntakeService } from '../src/integrations/email/intake-service.js';
import { DurableQueue } from '../src/jobs/queue.js';
import { RepositoryLockService } from '../src/jobs/repository-lock.js';
import { WorkerLeaseService } from '../src/jobs/worker-lease.js';
import { Database } from '../src/persistence/database.js';
import { migrate } from '../src/persistence/migrator.js';
import { PlannerService } from '../src/planner/planner-service.js';
import { RulePlanner } from '../src/planner/rule-planner.js';
import { PolicyPackService } from '../src/projects/policy-pack-service.js';
import { PublisherService } from '../src/publishing/publisher-service.js';
import {
  NotificationDispatcher,
  NotificationService,
} from '../src/notifications/notification-service.js';
import { DeploymentService } from '../src/deployment/deployment-service.js';
import {
  CleanupService,
  DiskPressureGuard,
  OperatorRecoveryService,
} from '../src/recovery/cleanup-service.js';
import { ReconciliationService } from '../src/recovery/reconciliation-service.js';
import { DailyReportService } from '../src/reporting/daily-report-service.js';
import { WeeklyReportService } from '../src/reporting/weekly-report-service.js';
import { RepositoryRegistryService } from '../src/repositories/registry-service.js';
import { GitClient } from '../src/repositories/git-client.js';
import { WorktreeService } from '../src/repositories/worktree-service.js';
import { SecurityAssessmentService } from '../src/security/release-assessment.js';
import { VerificationPipeline } from '../src/verification/pipeline.js';
import { ApprovalService } from '../src/services/approval-service.js';
import { CostService } from '../src/services/cost-service.js';
import { IdempotencyService } from '../src/services/idempotency-service.js';
import { IncomingMessageService } from '../src/services/incoming-message-service.js';
import { OutboxService } from '../src/services/outbox-service.js';
import { TaskQueryService } from '../src/services/task-query-service.js';
import { TaskService } from '../src/services/task-service.js';
import {
  FakeDeploymentAdapter,
  FakeNotificationGateway,
  FakePullRequestGateway,
  FakeReconciliationGateway,
} from './harness/failure-injection.js';
import {
  appConfig,
  PROJECT_ID,
  REPOSITORY_ID,
  taskContract,
} from './fixtures.js';

const connectionString = process.env.TEST_DATABASE_URL;
const migrationConnectionString =
  process.env.TEST_MIGRATION_DATABASE_URL ?? connectionString;
const describeDatabase = connectionString ? describe : describe.skip;

describeDatabase('PostgreSQL control-plane integration', () => {
  const database = new Database({
    url: connectionString ?? 'postgres://unavailable',
    ssl: false,
    migrationsDir: path.resolve('migrations'),
  });
  const migrationDatabase = new Database({
    url: migrationConnectionString ?? 'postgres://unavailable',
    ssl: false,
    migrationsDir: path.resolve('migrations'),
  });
  const tasks = new TaskService(database);

  beforeAll(async () => {
    await migrate(migrationDatabase, path.resolve('migrations'));
  });

  beforeEach(async () => {
    await migrationDatabase.query(
      'TRUNCATE projects, incoming_messages, idempotency_keys, outbox_events, webhook_deliveries CASCADE',
    );
    await database.query(
      `INSERT INTO projects (id, slug, name) VALUES ($1, 'fiberpass', 'FiberPass')`,
      [PROJECT_ID],
    );
    await database.query(
      `INSERT INTO repositories
        (id, project_id, github_repository_id, full_name, clone_url, default_branch,
         github_installation_id, worker_profile, verification_commands, enabled,
         onboarding_status)
       VALUES ($1, $2, 123, 'fidelcoder/fiberpassfrontend',
         'https://github.com/FidelCoder/fiberpassfrontend.git', 'main', 99,
         'frontend', '["pnpm test"]'::jsonb, true, 'APPROVED')`,
      [REPOSITORY_ID, PROJECT_ID],
    );
  });

  afterAll(async () => {
    await database.close();
    await migrationDatabase.close();
  });

  it('creates an inbox task exactly once and stores transitions with events', async () => {
    const input = {
      provider: 'TELEGRAM' as const,
      externalMessageId: 'update-1',
      senderId: '42',
      chatOrThreadId: '84',
      authenticated: true,
      envelope: { update_id: 1 },
      messageText: 'Add a frontend validation test',
      title: 'Add a frontend validation test',
      actorType: 'OWNER',
      actorId: '42',
      correlationId: randomUUID(),
    };
    const created = await tasks.createInboxTask(input);
    const replay = await tasks.createInboxTask(input);
    expect(created.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.task.id).toBe(created.task.id);

    const refining = await tasks.transition({
      taskId: created.task.id,
      expectedStatus: 'INBOX',
      expectedVersion: created.task.version,
      to: 'REFINING',
      actorRole: 'PLANNER',
      actorId: 'planner-v1',
      correlationId: randomUUID(),
    });
    const ready = await tasks.transition({
      taskId: created.task.id,
      expectedStatus: 'REFINING',
      expectedVersion: refining.version,
      to: 'READY',
      actorRole: 'PLANNER',
      actorId: 'planner-v1',
      correlationId: randomUUID(),
      contract: taskContract(),
    });
    expect(ready.status).toBe('READY');
    expect(ready.contract?.repositoryId).toBe(REPOSITORY_ID);

    const events = await database.query<{ event_type: string }>(
      'SELECT event_type FROM task_events WHERE task_id = $1 ORDER BY id',
      [ready.id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'TASK_CREATED',
      'TASK_TRANSITIONED',
      'TASK_TRANSITIONED',
    ]);
  });

  it('uses optimistic task versions to reject concurrent transitions', async () => {
    const created = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'update-2',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 2 },
      messageText: 'Improve frontend tests',
      title: 'Improve frontend tests',
      actorType: 'OWNER',
      actorId: '42',
    });
    const operation = () =>
      tasks.transition({
        taskId: created.task.id,
        expectedStatus: 'INBOX',
        expectedVersion: created.task.version,
        to: 'REFINING',
        actorRole: 'PLANNER',
        actorId: 'planner-v1',
        correlationId: randomUUID(),
      });
    const results = await Promise.allSettled([operation(), operation()]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('manages task dependencies without permitting cycles', async () => {
    const first = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'dependency-1',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 10 },
      messageText: 'Prepare frontend types',
      title: 'Prepare frontend types',
      actorType: 'OWNER',
      actorId: '42',
    });
    const second = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'dependency-2',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 11 },
      messageText: 'Use frontend types',
      title: 'Use frontend types',
      actorType: 'OWNER',
      actorId: '42',
    });
    expect(
      await tasks.addDependency(
        second.task.id,
        first.task.id,
        'PLANNER',
        'rule-planner-v1',
        randomUUID(),
      ),
    ).toBe(true);
    expect(
      await tasks.addDependency(
        second.task.id,
        first.task.id,
        'PLANNER',
        'rule-planner-v1',
        randomUUID(),
      ),
    ).toBe(false);
    await expect(
      tasks.addDependency(
        first.task.id,
        second.task.id,
        'PLANNER',
        'rule-planner-v1',
        randomUUID(),
      ),
    ).rejects.toThrow(/cycle/);
    expect(
      await tasks.removeDependency(
        second.task.id,
        first.task.id,
        'PLANNER',
        'rule-planner-v1',
        randomUUID(),
      ),
    ).toBe(true);
  });

  it('refines unambiguous tasks and blocks instead of guessing a repository', async () => {
    const readyTask = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'update-planner-ready',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 20 },
      messageText: 'Add a frontend validation test',
      title: 'Add a frontend validation test',
      actorType: 'OWNER',
      actorId: '42',
    });
    const planner = new PlannerService(
      database,
      tasks,
      new RulePlanner(appConfig()),
    );
    expect(
      (
        await planner.refine(
          readyTask.task.id,
          'Add a frontend validation test',
        )
      ).kind,
    ).toBe('READY');
    expect((await tasks.getTask(readyTask.task.id)).status).toBe('READY');
    const plannerRun = await database.query<{
      validation_result: string;
      input_tokens: string;
    }>(
      `SELECT validation_result, input_tokens::text
       FROM planner_runs WHERE task_id = $1`,
      [readyTask.task.id],
    );
    expect(plannerRun.rows[0]).toEqual({
      validation_result: 'READY',
      input_tokens: '0',
    });

    await database.query('UPDATE repositories SET enabled = false');
    const blockedTask = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'update-planner-blocked',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 21 },
      messageText: 'Improve validation',
      title: 'Improve validation',
      actorType: 'OWNER',
      actorId: '42',
    });
    expect(
      (await planner.refine(blockedTask.task.id, 'Improve validation')).kind,
    ).toBe('BLOCKED');
    expect((await tasks.getTask(blockedTask.task.id)).status).toBe('BLOCKED');
    const question = await database.query<{ question: string }>(
      'SELECT question FROM clarification_questions WHERE task_id = $1',
      [blockedTask.task.id],
    );
    expect(question.rows[0]?.question).toContain('No repository is enabled');
  });

  it('supports task queries, commands, incoming replay, and cost accounting', async () => {
    const created = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'update-services',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 30 },
      messageText: 'Inspect frontend budget',
      title: 'Inspect frontend budget',
      actorType: 'OWNER',
      actorId: '42',
    });
    expect(
      (
        await tasks.setPriority(
          created.task.id,
          80,
          'OWNER',
          '42',
          randomUUID(),
        )
      ).priority,
    ).toBe(80);
    expect(
      (
        await tasks.setPaused(
          created.task.id,
          true,
          'OWNER',
          '42',
          randomUUID(),
        )
      ).pausedAt,
    ).not.toBeNull();
    expect(
      (
        await tasks.setPaused(
          created.task.id,
          false,
          'OWNER',
          '42',
          randomUUID(),
        )
      ).pausedAt,
    ).toBeNull();

    const queries = new TaskQueryService(database);
    expect((await queries.resolve(created.task.taskKey)).id).toBe(
      created.task.id,
    );
    expect((await queries.active()).map((task) => task.id)).toContain(
      created.task.id,
    );

    const incoming = new IncomingMessageService(database);
    const messageInput = {
      provider: 'TELEGRAM' as const,
      externalId: 'command-1',
      senderId: '42',
      envelope: { update_id: 31 },
      body: '/status',
      correlationId: randomUUID(),
    };
    expect((await incoming.record(messageInput)).replayed).toBe(false);
    expect((await incoming.record(messageInput)).replayed).toBe(true);

    const costs = new CostService(database, {
      taskUsd: 5,
      dailyUsd: 25,
      monthlyUsd: 300,
    });
    await costs.record({
      taskId: created.task.id,
      projectId: PROJECT_ID,
      provider: 'test',
      model: 'fixture',
      inputTokens: 100,
      outputTokens: 20,
      amountUsd: 1.25,
    });
    expect(await costs.totalForTask(created.task.id)).toBe(1.25);
    await expect(
      costs.assertWithinBudget(created.task.id),
    ).resolves.toBeUndefined();
    const strictCosts = new CostService(database, {
      taskUsd: 1,
      dailyUsd: 25,
      monthlyUsd: 300,
    });
    await expect(
      strictCosts.assertWithinBudget(created.task.id),
    ).rejects.toThrow(/Task budget/);
  });

  it('provides replay-safe idempotency and single-use approvals', async () => {
    const created = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'update-3',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 3 },
      messageText: 'Review frontend budget',
      title: 'Review frontend budget',
      actorType: 'OWNER',
      actorId: '42',
    });
    const idempotency = new IdempotencyService(database);
    expect(
      (await idempotency.begin('test', 'key-1', { value: 1 })).acquired,
    ).toBe(true);
    await idempotency.complete('test', 'key-1', { result: 'ok' });
    expect(await idempotency.begin('test', 'key-1', { value: 1 })).toEqual({
      acquired: false,
      response: { result: 'ok' },
    });
    await expect(
      idempotency.begin('test', 'key-1', { value: 2 }),
    ).rejects.toThrow(/different request/);

    const approvals = new ApprovalService(database);
    const approval = await approvals.request(
      created.task.id,
      'BUDGET_INCREASE',
      '42',
      'Increase task budget',
    );
    await approvals.decide({
      approvalId: approval.approvalId,
      actorId: '42',
      token: approval.token,
      approved: true,
      reason: 'Approved for this task',
    });
    await expect(
      approvals.decide({
        approvalId: approval.approvalId,
        actorId: '42',
        token: approval.token,
        approved: true,
        reason: 'Replay',
      }),
    ).rejects.toThrow(/no longer pending/);

    const expiringApproval = await approvals.request(
      created.task.id,
      'BUDGET_INCREASE',
      '42',
      'Expired request',
    );
    await expect(
      approvals.decide({
        approvalId: expiringApproval.approvalId,
        actorId: '42',
        token: expiringApproval.token,
        approved: true,
        reason: 'Too late',
        now: new Date(expiringApproval.expiresAt.getTime() + 1),
      }),
    ).rejects.toThrow(/expired/);
    const expired = await database.query<{ status: string }>(
      'SELECT status FROM approvals WHERE id = $1',
      [expiringApproval.approvalId],
    );
    expect(expired.rows[0]?.status).toBe('EXPIRED');
  });

  it('claims outbox messages once and rejects mismatched replay keys', async () => {
    const outbox = new OutboxService(database);
    const request = {
      topic: 'notifications.telegram',
      aggregateType: 'task',
      aggregateId: PROJECT_ID,
      idempotencyKey: 'telegram:task-created:1',
      payload: { taskKey: 'PXR-0001' },
    };
    const created = await outbox.enqueue(request);
    expect(created.replayed).toBe(false);
    expect(await outbox.enqueue(request)).toEqual({
      id: created.id,
      replayed: true,
    });
    await expect(
      outbox.enqueue({ ...request, payload: { taskKey: 'PXR-9999' } }),
    ).rejects.toThrow(/different request/);

    const claimed = await outbox.claim('notifier-1', 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.attempts).toBe(1);
    await outbox.complete(created.id, 'notifier-1');
    expect(await outbox.claim('notifier-2', 10)).toEqual([]);
  });

  it('fences repository locks and worker leases', async () => {
    const first = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'update-4',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 4 },
      messageText: 'First frontend change',
      title: 'First frontend change',
      actorType: 'OWNER',
      actorId: '42',
    });
    const second = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'update-5',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 5 },
      messageText: 'Second frontend change',
      title: 'Second frontend change',
      actorType: 'OWNER',
      actorId: '42',
    });
    const locks = new RepositoryLockService(database);
    const lock = await locks.acquire({
      repositoryId: REPOSITORY_ID,
      taskId: first.task.id,
      workerId: 'worker-a',
      leaseMilliseconds: 60_000,
    });
    expect(lock).not.toBeNull();
    expect(
      await locks.acquire({
        repositoryId: REPOSITORY_ID,
        taskId: second.task.id,
        workerId: 'worker-b',
        leaseMilliseconds: 60_000,
      }),
    ).toBeNull();
    if (!lock) throw new Error('Expected lock');
    expect(await locks.heartbeat(lock, 60_000)).not.toBeNull();
    expect(await locks.release(lock)).toBe(true);

    const leases = new WorkerLeaseService(database);
    const lease = await leases.acquire(
      'TASK',
      first.task.id,
      'worker-a',
      60_000,
    );
    expect(lease).not.toBeNull();
    expect(
      await leases.acquire('TASK', first.task.id, 'worker-b', 60_000),
    ).toBeNull();
    if (!lease) throw new Error('Expected lease');
    expect(await leases.heartbeat(lease, 60_000)).not.toBeNull();
  });

  it('stores and enqueues each GitHub delivery once', async () => {
    const queue = {
      send: vi.fn().mockResolvedValue('job-1'),
    } as unknown as DurableQueue;
    const service = new GitHubWebhookService(
      {
        enabled: true,
        appId: 1,
        privateKey: 'unused',
        webhookSecret: 'unused-secure-secret',
        allowedRepositories: new Set(['fidelcoder/fiberpassfrontend']),
      },
      database,
      queue,
    );
    const input = {
      deliveryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      eventName: 'pull_request',
      rawBody: Buffer.from('{"action":"opened"}'),
      parsedBody: {
        action: 'opened',
        repository: { id: 123, full_name: 'FidelCoder/FiberPassFrontend' },
        pull_request: {
          id: 10,
          number: 2,
          state: 'open',
          merged: false,
          html_url: 'https://github.com/FidelCoder/FiberPassFrontend/pull/2',
          head: { sha: '1234567890abcdef' },
        },
      },
    };
    expect((await service.accept(input)).replayed).toBe(false);
    expect((await service.accept(input)).replayed).toBe(true);
    expect(queue.send).toHaveBeenCalledTimes(1);

    await database.query(
      `UPDATE webhook_deliveries SET status = 'FAILED'
       WHERE provider = 'GITHUB' AND delivery_id = $1`,
      [input.deliveryId],
    );
    expect((await service.accept(input)).replayed).toBe(true);
    expect(queue.send).toHaveBeenCalledTimes(2);
  });

  it('delivers durable notifications and idempotent daily reports', async () => {
    const created = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'report-task',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 70 },
      messageText: 'Prepare the daily report fixture',
      title: 'Prepare the daily report fixture',
      actorType: 'OWNER',
      actorId: '42',
    });
    const outbox = new OutboxService(database);
    const notifications = new NotificationService(outbox);
    await notifications.queue({
      taskId: created.task.id,
      taskKey: created.task.taskKey,
      event: 'ACCEPTED',
      text: '<unsafe>& accepted',
      destination: '42',
    });
    const gateway = new FakeNotificationGateway();
    const dispatcher = new NotificationDispatcher(database, outbox, gateway);
    expect(await dispatcher.deliverBatch('notifier-a')).toBe(1);
    expect(await dispatcher.deliverBatch('notifier-b')).toBe(0);
    expect(gateway.deliveries.size).toBe(1);
    expect(gateway.deliveries.values().next().value?.html).toContain(
      '&lt;unsafe&gt;&amp;',
    );

    const reports = new DailyReportService(database, outbox);
    const now = new Date(Date.now() + 1_000);
    const first = await reports.generate({
      timezone: 'Africa/Nairobi',
      now,
      destination: '42',
    });
    const replay = await reports.generate({
      timezone: 'Africa/Nairobi',
      now,
      destination: '42',
    });
    expect(replay).toMatchObject({
      reportId: first.reportId,
      replayed: true,
    });
    expect(first.body).toContain(created.task.taskKey);
    expect(await dispatcher.deliverBatch('notifier-c')).toBe(1);
    const stored = await database.query<{ delivery_status: string }>(
      'SELECT delivery_status FROM daily_reports WHERE id = $1',
      [first.reportId],
    );
    expect(stored.rows[0]?.delivery_status).toBe('SENT');
  });

  it('authenticates and correlates email threads without duplicating tasks', async () => {
    const email = new EmailIntakeService(database, tasks, [
      'owner@example.com',
    ]);
    const message = {
      provider: 'fixture',
      externalMessageId: 'email-1',
      externalThreadId: 'thread-1',
      sender: 'owner@example.com',
      subject: 'Add email intake validation',
      body: 'Please implement authenticated email intake validation.',
      authentication: {
        spf: 'PASS' as const,
        dkim: 'PASS' as const,
        dmarc: 'PASS' as const,
        alignedFrom: true as const,
      },
      attachments: [
        {
          filename: 'request.md',
          mediaType: 'text/markdown' as const,
          sizeBytes: 20,
          digest: 'a'.repeat(64),
          scanStatus: 'CLEAN' as const,
        },
      ],
    };
    const created = await email.ingest(message);
    expect(created.correlated).toBe(false);
    const replay = await email.ingest(message);
    expect(replay.replayed).toBe(true);
    expect(replay.task.id).toBe(created.task.id);
    const reply = await email.ingest({
      ...message,
      externalMessageId: 'email-2',
      subject: `[${created.task.taskKey}] Re: Add email intake validation`,
      body: 'Here is the requested clarification.',
      attachments: [],
    });
    expect(reply).toMatchObject({ correlated: true, replayed: false });
    const count = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks
       WHERE created_by_id = (SELECT sender_digest FROM email_threads LIMIT 1)`,
    );
    expect(count.rows[0]?.count).toBe('1');
    await expect(
      email.ingest({
        ...message,
        externalMessageId: 'email-3',
        sender: 'x@example.com',
      }),
    ).rejects.toThrow(/not authorized/);
  });

  it('persists deployment, security, weekly, and project policy evidence', async () => {
    const created = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'deployment-task',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 71 },
      messageText: 'Deploy a staging fixture',
      title: 'Deploy a staging fixture',
      actorType: 'OWNER',
      actorId: '42',
    });
    const adapter = new FakeDeploymentAdapter('PASSED');
    const deployments = new DeploymentService(database, adapter);
    const stagingInput = {
      taskId: created.task.id,
      commitSha: 'b'.repeat(40),
      environment: 'STAGING' as const,
      identity: 'staging:fixture',
      idempotencyKey: 'deploy:staging:fixture',
    };
    expect((await deployments.deploy(stagingInput)).status).toBe('SUCCEEDED');
    expect((await deployments.deploy(stagingInput)).replayed).toBe(true);

    const approvals = new ApprovalService(database);
    const approval = await approvals.request(
      created.task.id,
      'PRODUCTION_DEPLOYMENT',
      '42',
      'Production fixture approval',
    );
    await approvals.decide({
      approvalId: approval.approvalId,
      actorId: '42',
      token: approval.token,
      approved: true,
      reason: 'Approved for the test window',
    });
    const now = new Date();
    expect(
      (
        await deployments.deploy({
          taskId: created.task.id,
          commitSha: 'b'.repeat(40),
          environment: 'PRODUCTION',
          identity: 'production:fixture',
          idempotencyKey: 'deploy:production:fixture',
          approvalId: approval.approvalId,
          windowStart: new Date(now.getTime() - 1_000),
          windowEnd: new Date(now.getTime() + 60_000),
          now,
        })
      ).status,
    ).toBe('SUCCEEDED');

    const security = new SecurityAssessmentService(database);
    expect(
      (
        await security.record({
          commitSha: 'b'.repeat(40),
          controls: [
            {
              id: 'secrets',
              passed: true,
              evidence: 'scan passed',
              severity: 'HIGH',
            },
          ],
          vulnerabilities: [],
          residualRisks: [],
        })
      ).status,
    ).toBe('PASS');

    const policies = new PolicyPackService(database);
    const policyPackId = await policies.create({
      projectId: PROJECT_ID,
      version: 1,
      policy: {
        version: 1,
        repositoryIdentities: ['fidelcoder/fiberpassfrontend'],
        workerPool: 'fixture',
        portfolioBudgetUsd: 100,
        taskBudgetUsd: 5,
        allowedTaskClasses: ['test'],
        autoMergeEnabled: false,
        productionDeploymentEnabled: false,
      },
    });
    await policies.activate({
      projectId: PROJECT_ID,
      policyPackId,
      approvedBy: '42',
    });
    const active = await database.query<{ active: boolean }>(
      'SELECT active FROM project_policy_packs WHERE id = $1',
      [policyPackId],
    );
    expect(active.rows[0]?.active).toBe(true);

    const weekly = new WeeklyReportService(database);
    const windowEnd = new Date(Date.now() + 1_000);
    const windowStart = new Date(
      windowEnd.getTime() - 7 * 24 * 60 * 60 * 1_000,
    );
    const report = await weekly.generate({
      projectId: PROJECT_ID,
      windowStart,
      windowEnd,
    });
    expect(
      (
        await weekly.generate({
          projectId: PROJECT_ID,
          windowStart,
          windowEnd,
        })
      ).reportId,
    ).toBe(report.reportId);

    const acceptance = await new AcceptanceService(database).record({
      environment: 'local-integration',
      passNumber: 1,
      scenarios: RELEASE_ACCEPTANCE_SCENARIOS.map((id) => ({
        id,
        status: 'OPERATOR_GATED' as const,
        evidenceIds: [],
        notes: 'Live sandbox evidence is intentionally absent.',
      })),
    });
    expect(acceptance.status).toBe('OPERATOR_GATED');
  });

  it('reconciles CI, cleans terminal worktrees, and audits operator recovery', async () => {
    const created = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'reconcile-task',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 72 },
      messageText: 'Reconcile the pull request fixture',
      title: 'Reconcile the pull request fixture',
      actorType: 'OWNER',
      actorId: '42',
    });
    const refining = await tasks.transition({
      taskId: created.task.id,
      expectedStatus: 'INBOX',
      expectedVersion: created.task.version,
      to: 'REFINING',
      actorRole: 'PLANNER',
      actorId: 'planner',
      correlationId: randomUUID(),
    });
    const ready = await tasks.transition({
      taskId: created.task.id,
      expectedStatus: 'REFINING',
      expectedVersion: refining.version,
      to: 'READY',
      actorRole: 'PLANNER',
      actorId: 'planner',
      correlationId: randomUUID(),
      contract: taskContract(),
    });
    const building = await tasks.transition({
      taskId: created.task.id,
      expectedStatus: 'READY',
      expectedVersion: ready.version,
      to: 'BUILDING',
      actorRole: 'SCHEDULER',
      actorId: 'scheduler',
      correlationId: randomUUID(),
    });
    const reviewing = await tasks.transition({
      taskId: created.task.id,
      expectedStatus: 'BUILDING',
      expectedVersion: building.version,
      to: 'REVIEWING',
      actorRole: 'BUILDER_WORKER',
      actorId: 'builder',
      correlationId: randomUUID(),
    });
    const ci = await tasks.transition({
      taskId: created.task.id,
      expectedStatus: 'REVIEWING',
      expectedVersion: reviewing.version,
      to: 'CI',
      actorRole: 'REVIEWER',
      actorId: 'reviewer',
      correlationId: randomUUID(),
    });
    await database.query(
      `INSERT INTO pull_requests
        (id, task_id, repository_id, github_pull_request_id, number, url,
         head_sha, state)
       VALUES ($1, $2, $3, 500, 10, 'https://github.test/pull/10',
               $4, 'OPEN')`,
      [randomUUID(), ci.id, REPOSITORY_ID, 'c'.repeat(40)],
    );
    const reconciliation = new ReconciliationService(
      database,
      tasks,
      new FakeReconciliationGateway({
        state: 'OPEN',
        merged: false,
        headSha: 'c'.repeat(40),
        branchExists: true,
        requiredChecks: 'PASSED',
      }),
    );
    expect(await reconciliation.reconcileOpenPullRequests()).toBe(1);
    expect((await tasks.getTask(ci.id)).status).toBe('PR_READY');

    const terminal = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'cleanup-task',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 73 },
      messageText: 'Clean the terminal worktree fixture',
      title: 'Clean the terminal worktree fixture',
      actorType: 'OWNER',
      actorId: '42',
    });
    await database.query(
      `UPDATE tasks SET status = 'CANCELLED', repository_id = $2
       WHERE id = $1`,
      [terminal.task.id, REPOSITORY_ID],
    );
    const root = await mkdtemp(path.join(tmpdir(), 'praxrail-cleanup-'));
    const worktree = path.join(root, 'worktree');
    await mkdir(worktree);
    await database.query(
      'UPDATE repositories SET mirror_path = $2 WHERE id = $1',
      [REPOSITORY_ID, path.join(root, 'mirror.git')],
    );
    await database.query(
      `INSERT INTO git_refs
        (id, task_id, repository_id, base_sha, branch_name, worktree_path,
         status)
       VALUES ($1, $2, $3, $4, 'praxrail/cleanup-fixture', $5, 'ACTIVE')`,
      [randomUUID(), terminal.task.id, REPOSITORY_ID, 'd'.repeat(40), worktree],
    );
    const git = new GitClient();
    const removeWorktree = vi
      .spyOn(git, 'removeWorktree')
      .mockResolvedValue(undefined);
    try {
      const cleanup = new CleanupService(database, root, git);
      expect(await cleanup.cleanupTerminalWorktrees()).toBe(1);
      expect(removeWorktree).toHaveBeenCalledOnce();
      expect(await new DiskPressureGuard(root, 1).canClaimWork()).toBe(true);

      await database.query(
        `INSERT INTO repository_locks
          (repository_id, task_id, worker_id, fencing_token, expires_at)
         VALUES ($1, $2, 'dead-worker', 99, now() - interval '1 minute')`,
        [REPOSITORY_ID, terminal.task.id],
      );
      const recovery = new OperatorRecoveryService(database);
      expect(
        await recovery.releaseExpiredRepositoryLock({
          repositoryId: REPOSITORY_ID,
          actorId: 'operator-1',
          reason: 'Expired worker lease recovery',
        }),
      ).toBe(true);
      const outbox = new OutboxService(database);
      const event = await outbox.enqueue({
        topic: 'fixture',
        aggregateType: 'task',
        aggregateId: terminal.task.id,
        idempotencyKey: 'fixture:operator-retry',
        payload: { fixture: true },
      });
      await outbox.claim('stalled-worker', 1, 'fixture');
      await recovery.retryOutbox({
        outboxId: event.id,
        actorId: 'operator-1',
        reason: 'Retry stalled fixture delivery',
      });
      const actions = await database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM operator_actions',
      );
      expect(actions.rows[0]?.count).toBe('2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires inspection and owner approval before repository writes', async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), 'praxrail-onboarding-'));
    const git = new GitClient();
    try {
      await git.run(['init', '-b', 'main'], { cwd: checkout });
      await git.run(
        [
          'remote',
          'add',
          'origin',
          'https://github.com/FidelCoder/Praxrail.git',
        ],
        { cwd: checkout },
      );
      await writeFile(path.join(checkout, 'AGENTS.md'), '# Fixture policy\n');
      await git.run(['add', 'AGENTS.md'], { cwd: checkout });
      await git.run(
        [
          '-c',
          'user.name=Praxrail Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '-m',
          'fixture',
        ],
        { cwd: checkout },
      );
      const command = (name: string, layer: string) => ({
        name,
        layer,
        executable: 'pnpm',
        args: [name],
        required: true,
        timeoutMs: 60_000,
      });
      const policy = {
        version: 1 as const,
        fullName: 'fidelcoder/praxrail',
        cloneUrl: 'https://github.com/FidelCoder/Praxrail.git',
        defaultBranch: 'main',
        installationId: 999,
        workerProfile: 'general' as const,
        container: {
          image: 'node@sha256:' + 'a'.repeat(64),
          cpus: 1,
          memoryMb: 1024,
          processLimit: 128,
        },
        writeConcurrency: 1 as const,
        commands: [
          command('format', 'FORMAT'),
          command('lint', 'LINT'),
          command('types', 'TYPECHECK'),
          command('unit', 'UNIT_TEST'),
          command('build', 'BUILD'),
        ],
        submodules: 'DENY' as const,
        allowedSubmodules: [],
        networkPolicy: 'NONE' as const,
        riskOverrides: {},
      };
      const registry = new RepositoryRegistryService(database, git);
      const repositoryId = await registry.registerCandidate({
        projectId: PROJECT_ID,
        githubRepositoryId: 999,
        policy: policy as Parameters<
          RepositoryRegistryService['registerCandidate']
        >[0]['policy'],
        mirrorPath: path.join(checkout, 'mirror.git'),
      });
      const report = await registry.inspect({
        repositoryId,
        checkoutPath: checkout,
        policy: policy as Parameters<
          RepositoryRegistryService['inspect']
        >[0]['policy'],
        commandResults: [
          {
            startedAt: new Date(),
            durationMs: 1,
            exitCode: 0,
            stdout: '',
            stderr: '',
            failure: 'NONE',
            truncated: false,
          },
        ],
        actorId: 'onboarding-worker',
      });
      expect(report.safeForWrites).toBe(true);
      await registry.approve(repositoryId, report.id, 'owner-42');
      const approved = await database.query<{
        enabled: boolean;
        onboarding_status: string;
      }>(`SELECT enabled, onboarding_status FROM repositories WHERE id = $1`, [
        repositoryId,
      ]);
      expect(approved.rows[0]).toEqual({
        enabled: true,
        onboarding_status: 'APPROVED',
      });
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it('creates fenced task worktrees, fetches existing mirrors, and cleans safely', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'praxrail-worktrees-'));
    const mirrors = path.join(root, 'mirrors');
    const worktrees = path.join(root, 'worktrees');
    const git = new GitClient();
    const cloneMirror = vi
      .spyOn(git, 'cloneMirror')
      .mockImplementation(async (_url, mirrorPath) => {
        await mkdir(mirrorPath, { recursive: true });
      });
    const fetchMirror = vi
      .spyOn(git, 'fetchMirror')
      .mockResolvedValue(undefined);
    vi.spyOn(git, 'remoteUrl').mockResolvedValue(
      'https://github.com/FidelCoder/FiberPassFrontend.git',
    );
    vi.spyOn(git, 'resolveRef').mockResolvedValue('e'.repeat(40));
    vi.spyOn(git, 'addWorktree').mockImplementation(
      async (_mirrorPath, worktreePath) => {
        await mkdir(worktreePath, { recursive: true });
      },
    );
    const removeWorktree = vi
      .spyOn(git, 'removeWorktree')
      .mockResolvedValue(undefined);
    const locks = new RepositoryLockService(database);
    const worktreeService = new WorktreeService(
      database,
      locks,
      mirrors,
      worktrees,
      git,
    );
    const repository = {
      id: REPOSITORY_ID,
      fullName: 'fidelcoder/fiberpassfrontend',
      cloneUrl: 'https://github.com/FidelCoder/FiberPassFrontend.git',
      defaultBranch: 'main',
    };
    try {
      const firstTask = await tasks.createInboxTask({
        provider: 'TELEGRAM',
        externalMessageId: 'worktree-1',
        senderId: '42',
        authenticated: true,
        envelope: { update_id: 75 },
        messageText: 'Create the first worktree fixture',
        title: 'Create the first worktree fixture',
        actorType: 'OWNER',
        actorId: '42',
      });
      const firstInput = {
        repository,
        taskId: firstTask.task.id,
        taskKey: firstTask.task.taskKey,
        taskTitle: firstTask.task.title,
        attemptNumber: 1,
        workerId: 'worker-1',
        leaseMilliseconds: 60_000,
      };
      const first = await worktreeService.create(firstInput);
      expect(first.branchName).toMatch(/^praxrail\//);
      expect(cloneMirror).toHaveBeenCalledOnce();
      await expect(worktreeService.create(firstInput)).rejects.toThrow(
        /already owns active worktree/,
      );
      await worktreeService.cleanup(first);

      const secondTask = await tasks.createInboxTask({
        provider: 'TELEGRAM',
        externalMessageId: 'worktree-2',
        senderId: '42',
        authenticated: true,
        envelope: { update_id: 76 },
        messageText: 'Create the second worktree fixture',
        title: 'Create the second worktree fixture',
        actorType: 'OWNER',
        actorId: '42',
      });
      const attemptId = randomUUID();
      await database.query(
        `INSERT INTO task_attempts
          (id, task_id, attempt_number, status, worker_id)
         VALUES ($1, $2, 1, 'CLAIMED', 'worker-2')`,
        [attemptId, secondTask.task.id],
      );
      const second = await worktreeService.create({
        repository,
        taskId: secondTask.task.id,
        taskKey: secondTask.task.taskKey,
        taskTitle: secondTask.task.title,
        attemptId,
        attemptNumber: 1,
        workerId: 'worker-2',
        leaseMilliseconds: 60_000,
      });
      expect(fetchMirror).toHaveBeenCalledOnce();
      expect(second.attemptId).toBe(attemptId);
      await worktreeService.cleanup(second);
      expect(removeWorktree).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds, verifies, reviews, and publishes the exact diff once', async () => {
    const created = await tasks.createInboxTask({
      provider: 'TELEGRAM',
      externalMessageId: 'agent-task',
      senderId: '42',
      authenticated: true,
      envelope: { update_id: 74 },
      messageText: 'Update the tracked fixture file',
      title: 'Update the tracked fixture file',
      actorType: 'OWNER',
      actorId: '42',
    });
    const attemptId = randomUUID();
    await database.query(
      `INSERT INTO task_attempts
        (id, task_id, attempt_number, status, worker_id, started_at)
       VALUES ($1, $2, 1, 'RUNNING', 'builder-fixture', now())`,
      [attemptId, created.task.id],
    );
    const checkout = await mkdtemp(path.join(tmpdir(), 'praxrail-agent-'));
    const git = new GitClient();
    try {
      await git.run(['init', '-b', 'main'], { cwd: checkout });
      await writeFile(path.join(checkout, 'README.md'), 'before\n');
      await git.run(['add', 'README.md'], { cwd: checkout });
      await git.run(
        [
          '-c',
          'user.name=Praxrail Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '-m',
          'base',
        ],
        { cwd: checkout },
      );
      const baseSha = await git.headSha(checkout);
      const builderProvider: AgentProvider = {
        run: async () => {
          await writeFile(path.join(checkout, 'README.md'), 'after\n');
          return {
            threadId: 'builder-thread',
            finalResponse: JSON.stringify({
              version: 1,
              summary: 'Updated the tracked fixture.',
              changedFiles: ['README.md'],
              commandsRun: [],
              knownLimitations: [],
              proposedVerification: ['fixture'],
            }),
            toolActions: [],
            usage: {
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              reasoningTokens: 1,
            },
          };
        },
      };
      const builder = new BuilderService(database, builderProvider, git);
      const built = await builder.run({
        taskId: created.task.id,
        attemptId,
        workerProfile: 'general',
        worktreePath: checkout,
        baseSha,
        contract: taskContract(),
        instructions: [],
        model: 'fake-builder',
        timeoutMs: 5_000,
      });
      expect(built.changedFiles).toEqual(['README.md']);

      const runner = new RestrictedRunner(path.dirname(checkout), {
        allowHostExecution: true,
      });
      vi.spyOn(runner, 'execute').mockResolvedValue({
        startedAt: new Date(),
        durationMs: 1,
        exitCode: 0,
        stdout: 'passed',
        stderr: '',
        failure: 'NONE',
        truncated: false,
      });
      const verification = await new VerificationPipeline(
        database,
        runner,
        git,
      ).run({
        taskId: created.task.id,
        attemptId,
        worktreePath: checkout,
        baseSha,
        commands: [
          {
            name: 'fixture',
            layer: 'UNIT_TEST',
            executable: 'pnpm',
            args: ['test'],
            required: true,
            timeoutMs: 5_000,
          },
        ],
        container: {
          image: 'node@sha256:' + 'a'.repeat(64),
          cpus: 1,
          memoryMb: 128,
          processLimit: 32,
          network: 'none',
        },
      });
      expect(verification.passed).toBe(true);

      const reviewerProvider: AgentProvider = {
        run: async () => ({
          threadId: 'reviewer-thread',
          finalResponse: JSON.stringify({
            version: 1,
            summary: 'No blocking findings.',
            findings: [],
          }),
          toolActions: [],
          usage: {
            inputTokens: 8,
            cachedInputTokens: 0,
            outputTokens: 3,
            reasoningTokens: 1,
          },
        }),
      };
      const review = await new ReviewService(
        database,
        reviewerProvider,
        git,
      ).review({
        taskId: created.task.id,
        attemptId,
        worktreePath: checkout,
        baseSha,
        reviewedSha: built.diffDigest,
        contract: taskContract(),
        instructions: [],
        verification,
        changedFiles: built.changedFiles,
        workerProfile: 'general',
        model: 'fake-reviewer',
        timeoutMs: 5_000,
      });
      expect(review.completion.findings).toEqual([]);

      const branchName = 'praxrail/agent-fixture';
      await git.run(['branch', branchName, baseSha], { cwd: checkout });
      const gitRefId = randomUUID();
      await database.query(
        `INSERT INTO git_refs
          (id, task_id, attempt_id, repository_id, base_sha, branch_name,
           worktree_path, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
        [
          gitRefId,
          created.task.id,
          attemptId,
          REPOSITORY_ID,
          baseSha,
          branchName,
          checkout,
        ],
      );
      vi.spyOn(git, 'pushBranch').mockResolvedValue(undefined);
      const pullRequests = new FakePullRequestGateway();
      const publisher = new PublisherService(database, pullRequests, git);
      const publishInput = {
        taskId: created.task.id,
        taskKey: created.task.taskKey,
        repositoryId: REPOSITORY_ID,
        repositoryFullName: 'fidelcoder/fiberpassfrontend',
        defaultBranch: 'main',
        worktreePath: checkout,
        gitRefId,
        branchName,
        baseSha,
        reviewedDiffDigest: built.diffDigest,
        reviewRunId: review.reviewRunId,
        contract: taskContract(),
        changeSummary: built.completion.summary,
        verificationSummary: 'Fixture verification passed.',
        reviewSummary: review.completion.summary,
        gitIdentity: {
          name: 'Praxrail',
          email: 'praxrail@example.com',
        },
      };
      const published = await publisher.publish(publishInput);
      expect(published.replayed).toBe(false);
      expect((await publisher.publish(publishInput)).replayed).toBe(true);
      expect(pullRequests.requests.size).toBe(1);
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });
});

describeDatabase('durable queue integration', () => {
  it('delivers a queued job to one worker', async () => {
    const queue = new DurableQueue(
      connectionString ?? 'postgres://unavailable',
    );
    await queue.start();
    try {
      const received = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for job')),
          10_000,
        );
        void queue.work<{ marker: string }>('intake', async (job) => {
          clearTimeout(timeout);
          resolve(job.data.marker);
        });
      });
      await queue.send(
        'intake',
        { marker: 'delivered' },
        { idempotencyKey: randomUUID() },
      );
      await expect(received).resolves.toBe('delivered');
    } finally {
      await queue.stop();
    }
  }, 20_000);
});
