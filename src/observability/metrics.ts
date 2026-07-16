import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

export class Metrics {
  readonly registry = new Registry();
  readonly externalEvents = new Counter({
    name: 'praxrail_external_events_total',
    help: 'Authenticated and rejected external events',
    labelNames: ['provider', 'event', 'result'] as const,
    registers: [this.registry],
  });
  readonly taskTransitions = new Counter({
    name: 'praxrail_task_transitions_total',
    help: 'Task state transitions',
    labelNames: ['from', 'to', 'result'] as const,
    registers: [this.registry],
  });
  readonly jobDuration = new Histogram({
    name: 'praxrail_job_duration_seconds',
    help: 'Job processing duration',
    labelNames: ['queue', 'result'] as const,
    buckets: [0.05, 0.2, 1, 5, 15, 60, 300, 900],
    registers: [this.registry],
  });
  readonly queueLatency = new Histogram({
    name: 'praxrail_queue_latency_seconds',
    help: 'Time jobs spend waiting before a worker claims them',
    labelNames: ['queue'] as const,
    buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900],
    registers: [this.registry],
  });
  readonly jobRetries = new Counter({
    name: 'praxrail_job_retries_total',
    help: 'Job retries and exhausted attempts',
    labelNames: ['queue', 'result'] as const,
    registers: [this.registry],
  });
  readonly deadLetters = new Gauge({
    name: 'praxrail_dead_letter_jobs',
    help: 'Jobs currently waiting in dead-letter queues',
    labelNames: ['queue'] as const,
    registers: [this.registry],
  });
  readonly lockWait = new Histogram({
    name: 'praxrail_repository_lock_wait_seconds',
    help: 'Time workers spend waiting for repository write locks',
    labelNames: ['repository'] as const,
    buckets: [0.01, 0.1, 0.5, 1, 5, 15, 60],
    registers: [this.registry],
  });
  readonly activeTasks = new Gauge({
    name: 'praxrail_active_tasks',
    help: 'Current active tasks by state',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });
  readonly modelCostUsd = new Counter({
    name: 'praxrail_model_cost_usd_total',
    help: 'Recorded model cost in USD',
    labelNames: ['provider', 'model'] as const,
    registers: [this.registry],
  });
  readonly budgetUtilization = new Gauge({
    name: 'praxrail_budget_utilization_ratio',
    help: 'Current spend divided by configured budget',
    labelNames: ['period'] as const,
    registers: [this.registry],
  });
  readonly databaseReady = new Gauge({
    name: 'praxrail_database_ready',
    help: 'Whether the control-plane database is ready',
    registers: [this.registry],
  });
  readonly verificationFailures = new Counter({
    name: 'praxrail_verification_failures_total',
    help: 'Required verification failures',
    labelNames: ['repository', 'verification'] as const,
    registers: [this.registry],
  });
  readonly reviewFindings = new Counter({
    name: 'praxrail_review_findings_total',
    help: 'Independent review findings by severity',
    labelNames: ['severity'] as const,
    registers: [this.registry],
  });
  readonly notifications = new Counter({
    name: 'praxrail_notifications_total',
    help: 'Notification delivery results',
    labelNames: ['provider', 'result'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({
      register: this.registry,
      prefix: 'praxrail_process_',
    });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
