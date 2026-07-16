import { z } from 'zod';
import type { AppConfig } from './config.js';
import { GitHubAppClient } from './integrations/github/auth.js';
import { GitHubWebhookService } from './integrations/github/webhook-service.js';
import { TelegramCommandService } from './integrations/telegram/command-service.js';
import { TelegramProcessor } from './integrations/telegram/processor.js';
import { DurableQueue } from './jobs/queue.js';
import { Metrics } from './observability/metrics.js';
import { runWithTrace } from './observability/context.js';
import { Database } from './persistence/database.js';
import { PlannerService } from './planner/planner-service.js';
import { RulePlanner } from './planner/rule-planner.js';
import { ApprovalService } from './services/approval-service.js';
import { CostService } from './services/cost-service.js';
import { IncomingMessageService } from './services/incoming-message-service.js';
import { TaskQueryService } from './services/task-query-service.js';
import { TaskService } from './services/task-service.js';

const planningJobSchema = z.object({
  taskId: z.uuid(),
  text: z.string().min(1).max(10_000),
  correlationId: z.uuid(),
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
  return {
    config,
    database,
    queue,
    metrics,
    telegram,
    githubWebhooks,
    planner,
    githubApp,
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
}

export async function stopRuntime(runtime: Runtime): Promise<void> {
  await runtime.queue.stop();
  await runtime.database.close();
}
