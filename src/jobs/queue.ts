import { PgBoss, type Job, type WorkOptions } from 'pg-boss';

export const QUEUES = [
  'intake',
  'planning',
  'building',
  'review',
  'publishing',
  'reconciliation',
  'cleanup',
  'notifications',
  'reports',
] as const;

export type QueueName = (typeof QUEUES)[number];

export interface QueuePolicy {
  retryLimit: number;
  retryDelaySeconds: number;
}

export class DurableQueue {
  private readonly boss: PgBoss;

  constructor(
    connectionString: string,
    private readonly policy: QueuePolicy = {
      retryLimit: 3,
      retryDelaySeconds: 5,
    },
  ) {
    this.boss = new PgBoss({
      connectionString,
      schema: 'praxrail_jobs',
      application_name: 'praxrail-jobs',
      migrate: false,
      useListenNotify: true,
      persistWarnings: true,
    });
  }

  onError(handler: (error: Error) => void): void {
    this.boss.on('error', handler);
  }

  async start(): Promise<void> {
    await this.boss.start();
    for (const queue of QUEUES) {
      await this.boss.createQueue(`${queue}-dead-letter`, {
        retryLimit: 0,
        deleteAfterSeconds: 30 * 24 * 60 * 60,
      });
      await this.boss.createQueue(queue, {
        retryLimit: this.policy.retryLimit,
        retryDelay: this.policy.retryDelaySeconds,
        retryBackoff: true,
        retryDelayMax: 300,
        expireInSeconds: 15 * 60,
        retentionSeconds: 14 * 24 * 60 * 60,
        deleteAfterSeconds: 7 * 24 * 60 * 60,
        deadLetter: `${queue}-dead-letter`,
      });
    }
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 30_000 });
  }

  async send(
    name: QueueName,
    data: object,
    options: {
      idempotencyKey?: string;
      priority?: number;
      startAfter?: Date;
    } = {},
  ): Promise<string | null> {
    return this.boss.send(name, data, {
      ...(options.idempotencyKey
        ? { singletonKey: options.idempotencyKey }
        : {}),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      ...(options.startAfter ? { startAfter: options.startAfter } : {}),
    });
  }

  async work<T extends object>(
    name: QueueName,
    handler: (job: Job<T>) => Promise<void>,
    options: WorkOptions = {},
  ): Promise<string> {
    return this.boss.work<T>(name, options, async (jobs) => {
      for (const job of jobs) await handler(job);
    });
  }
}
