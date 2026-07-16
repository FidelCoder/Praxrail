import { randomUUID } from 'node:crypto';
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
import { GitHubWebhookService } from '../src/integrations/github/webhook-service.js';
import { DurableQueue } from '../src/jobs/queue.js';
import { RepositoryLockService } from '../src/jobs/repository-lock.js';
import { WorkerLeaseService } from '../src/jobs/worker-lease.js';
import { Database } from '../src/persistence/database.js';
import { migrate } from '../src/persistence/migrator.js';
import { PlannerService } from '../src/planner/planner-service.js';
import { RulePlanner } from '../src/planner/rule-planner.js';
import { ApprovalService } from '../src/services/approval-service.js';
import { CostService } from '../src/services/cost-service.js';
import { IdempotencyService } from '../src/services/idempotency-service.js';
import { IncomingMessageService } from '../src/services/incoming-message-service.js';
import { OutboxService } from '../src/services/outbox-service.js';
import { TaskQueryService } from '../src/services/task-query-service.js';
import { TaskService } from '../src/services/task-service.js';
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
         github_installation_id, worker_profile, verification_commands, enabled)
       VALUES ($1, $2, 123, 'fidelcoder/fiberpassfrontend',
         'https://github.com/FidelCoder/fiberpassfrontend.git', 'main', 99,
         'frontend', '["pnpm test"]'::jsonb, true)`,
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
