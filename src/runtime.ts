import { z } from 'zod';
import { CodexSdkProvider, type AgentProvider } from './agents/provider.js';
import type { AppConfig } from './config.js';
import { GitHubAppClient } from './integrations/github/auth.js';
import { GitHubAutomationGateway } from './integrations/github/automation-gateway.js';
import { GitHubWebhookService } from './integrations/github/webhook-service.js';
import { TelegramCommandService } from './integrations/telegram/command-service.js';
import { TelegramNotificationGateway } from './integrations/telegram/notification-gateway.js';
import { TelegramProcessor } from './integrations/telegram/processor.js';
import { DurableQueue } from './jobs/queue.js';
import { NotificationDispatcher } from './notifications/notification-service.js';
import { Metrics } from './observability/metrics.js';
import { runWithTrace } from './observability/context.js';
import { Database } from './persistence/database.js';
import { PlannerService } from './planner/planner-service.js';
import { RulePlanner } from './planner/rule-planner.js';
import { CleanupService } from './recovery/cleanup-service.js';
import { ReconciliationService } from './recovery/reconciliation-service.js';
import {
  DailyReportScheduler,
  DailyReportService,
} from './reporting/daily-report-service.js';
import { ApprovalService } from './services/approval-service.js';
import { CostService } from './services/cost-service.js';
import { IncomingMessageService } from './services/incoming-message-service.js';
import { OutboxService } from './services/outbox-service.js';
import { TaskQueryService } from './services/task-query-service.js';
import { TaskService } from './services/task-service.js';

const planningJobSchema = z.object({
  taskId: z.uuid(),
  text: z.string().min(1).max(10_000),
  correlationId: z.uuid(),
});

const reportingJobSchema = z.object({
  destination: z.string().min(1).max(200),
});

export interface Runtime {
  config: AppConfig;
  database: Database;
  queue: DurableQueue;
  metrics: Metrics;
  telegram: TelegramProcessor;
  githubWebhooks: GitHubWebhookService;
  planner: PlannerService;
  githubApp: GitHubAppClient | null;
  githubAutomation: GitHubAutomationGateway | null;
  agentProviders: {
    builder: AgentProvider;
    reviewer: AgentProvider;
  } | null;
  reconciliation: ReconciliationService | null;
  cleanup: CleanupService;
  notifications: NotificationDispatcher | null;
  reports: DailyReportService | null;
  reportScheduler: DailyReportScheduler;
  maintenanceTimer: NodeJS.Timeout | null;
}

export function createRuntime(config: AppConfig): Runtime {
  const database = new Database(config.database);
  const queue = new DurableQueue(config.database.url, {
    retryLimit: config.jobs.retryLimit,
    retryDelaySeconds: config.jobs.retryDelaySeconds,
  });
  const metrics = new Metrics();
  const tasks = new TaskService(database);
  const approvals = new ApprovalService(database);
  const costs = new CostService(database, config.budget);
  const incomingMessages = new IncomingMessageService(database);
  const queries = new TaskQueryService(database);
  const commands = new TelegramCommandService(
    config,
    tasks,
    queries,
    approvals,
    costs,
  );
  const telegram = new TelegramProcessor(
    tasks,
    incomingMessages,
    commands,
    queue,
  );
  const planner = new PlannerService(database, tasks, new RulePlanner(config));
  const githubWebhooks = new GitHubWebhookService(
    config.github,
    database,
    queue,
  );
  const githubApp = config.github.enabled
    ? new GitHubAppClient(config.github)
    : null;
  const githubAutomation = githubApp
    ? new GitHubAutomationGateway(database, githubApp)
    : null;
  const reconciliation = githubAutomation
    ? new ReconciliationService(database, tasks, githubAutomation)
    : null;
  const outbox = new OutboxService(database);
  const telegramGateway =
    config.telegram.enabled && config.telegram.botToken
      ? new TelegramNotificationGateway(config.telegram.botToken)
      : null;
  const notifications = telegramGateway
    ? new NotificationDispatcher(database, outbox, telegramGateway)
    : null;
  const reports = telegramGateway
    ? new DailyReportService(database, outbox)
    : null;
  const agentProviders =
    config.codex.enabled &&
    config.codex.builderApiKey &&
    config.codex.reviewerApiKey
      ? {
          builder: new CodexSdkProvider(config.codex.builderApiKey),
          reviewer: new CodexSdkProvider(config.codex.reviewerApiKey),
        }
      : null;
  return {
    config,
    database,
    queue,
    metrics,
    telegram,
    githubWebhooks,
    planner,
    githubApp,
    githubAutomation,
    agentProviders,
    reconciliation,
    cleanup: new CleanupService(database, config.paths.workspaceRoot),
    notifications,
    reports,
    reportScheduler: new DailyReportScheduler(),
    maintenanceTimer: null,
  };
}

export async function startRuntime(runtime: Runtime): Promise<void> {
  runtime.queue.onError((error) => {
    process.stderr.write(`Queue error: ${error.message}\n`);
  });
  await runtime.queue.start();
  await runtime.queue.work(
    'planning',
    async (job) => {
      const data = planningJobSchema.parse(job.data);
      await runWithTrace(
        {
          correlationId: data.correlationId,
          taskId: data.taskId,
          jobId: job.id,
        },
        () =>
          runtime.planner.refine(data.taskId, data.text, data.correlationId),
      );
    },
    { batchSize: runtime.config.jobs.concurrency },
  );
  if (runtime.reconciliation) {
    await runtime.queue.work('reconciliation', async () => {
      await runtime.reconciliation?.reconcileOpenPullRequests();
    });
    await runtime.queue.send(
      'reconciliation',
      { trigger: 'startup' },
      { idempotencyKey: 'reconciliation:startup' },
    );
  }
  await runtime.queue.work('cleanup', async () => {
    await runtime.cleanup.cleanupTerminalWorktrees();
  });
  if (runtime.notifications) {
    await runtime.queue.work('notifications', async (job) => {
      await runtime.notifications?.deliverBatch(`notification-${job.id}`);
    });
    await runtime.queue.send(
      'notifications',
      { trigger: 'startup' },
      { idempotencyKey: 'notifications:startup' },
    );
  }
  const destination = runtime.config.telegram.allowedChatIds
    .values()
    .next().value;
  if (runtime.reports && destination !== undefined) {
    await runtime.queue.work('reports', async (job) => {
      const data = reportingJobSchema.parse(job.data);
      await runtime.reports?.generate({
        timezone: runtime.config.owner.timezone,
        destination: data.destination,
      });
    });
    runtime.reportScheduler.start({
      time: runtime.config.owner.dailyReportTime,
      timezone: runtime.config.owner.timezone,
      operation: async () => {
        await runtime.queue.send(
          'reports',
          { destination: String(destination) },
          {
            idempotencyKey: `daily-report-${new Date().toISOString().slice(0, 10)}`,
          },
        );
      },
    });
  }
  runtime.maintenanceTimer = setInterval(() => {
    const notificationBucket = Math.floor(Date.now() / 15_000);
    const maintenanceBucket = Math.floor(Date.now() / 300_000);
    const operations: Promise<unknown>[] = [];
    if (runtime.notifications) {
      operations.push(
        runtime.queue.send(
          'notifications',
          { trigger: 'poll' },
          { idempotencyKey: `notifications:${notificationBucket}` },
        ),
      );
    }
    operations.push(
      runtime.queue.send(
        'cleanup',
        { trigger: 'schedule' },
        { idempotencyKey: `cleanup:${maintenanceBucket}` },
      ),
    );
    if (runtime.reconciliation) {
      operations.push(
        runtime.queue.send(
          'reconciliation',
          { trigger: 'schedule' },
          { idempotencyKey: `reconciliation:${maintenanceBucket}` },
        ),
      );
    }
    void Promise.all(operations).catch((error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : 'Maintenance scheduling failed';
      process.stderr.write(`Maintenance error: ${message}\n`);
    });
  }, 15_000);
  runtime.maintenanceTimer.unref();
}

export async function stopRuntime(runtime: Runtime): Promise<void> {
  if (runtime.maintenanceTimer) clearInterval(runtime.maintenanceTimer);
  runtime.maintenanceTimer = null;
  runtime.reportScheduler.stop();
  await runtime.queue.stop();
  await runtime.database.close();
}
