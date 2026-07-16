import { createHash, randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import { AuthorizationError } from '../../domain/errors.js';
import type { DurableQueue } from '../../jobs/queue.js';
import type { Database } from '../../persistence/database.js';
import {
  githubWebhookPayloadSchema,
  normalizeGitHubEvent,
  SUPPORTED_GITHUB_EVENTS,
  type NormalizedGitHubEvent,
} from './schema.js';

export class GitHubWebhookService {
  constructor(
    private readonly config: AppConfig['github'],
    private readonly database: Database,
    private readonly queue: DurableQueue,
  ) {}

  async accept(input: {
    deliveryId: string;
    eventName: string;
    rawBody: Buffer;
    parsedBody: unknown;
  }): Promise<{ replayed: boolean; event: NormalizedGitHubEvent }> {
    if (!SUPPORTED_GITHUB_EVENTS.has(input.eventName)) {
      throw new AuthorizationError(
        `GitHub event ${input.eventName} is not enabled`,
      );
    }
    const payload = githubWebhookPayloadSchema.parse(input.parsedBody);
    const event = normalizeGitHubEvent(input.eventName, payload);
    if (
      event.repositoryFullName &&
      !this.config.allowedRepositories.has(event.repositoryFullName)
    ) {
      throw new AuthorizationError(
        `Repository ${event.repositoryFullName} is not allowed`,
      );
    }

    let correlationId: string = randomUUID();
    const payloadDigest = createHash('sha256')
      .update(input.rawBody)
      .digest('hex');
    const inserted = await this.database.query(
      `INSERT INTO webhook_deliveries
        (provider, delivery_id, event_name, repository_full_name, payload_digest,
         status, correlation_id)
       VALUES ('GITHUB', $1, $2, $3, $4, 'RECEIVED', $5)
       ON CONFLICT (provider, delivery_id) DO NOTHING`,
      [
        input.deliveryId,
        input.eventName,
        event.repositoryFullName ?? null,
        payloadDigest,
        correlationId,
      ],
    );
    const replayed = inserted.rowCount === 0;
    if (replayed) {
      const prior = await this.database.query<{
        status: string;
        correlation_id: string;
      }>(
        `SELECT status, correlation_id FROM webhook_deliveries
         WHERE provider = 'GITHUB' AND delivery_id = $1`,
        [input.deliveryId],
      );
      const delivery = prior.rows[0];
      if (!delivery) throw new Error('Webhook replay record was not found');
      if (delivery.status === 'PROCESSED' || delivery.status === 'REJECTED') {
        return { replayed: true, event };
      }
      correlationId = delivery.correlation_id;
    }

    try {
      await this.queue.send(
        'reconciliation',
        { deliveryId: input.deliveryId, event, correlationId },
        {
          idempotencyKey: `github:${input.deliveryId}`,
        },
      );
      await this.database.query(
        `UPDATE webhook_deliveries SET status = 'PROCESSED', processed_at = now()
         WHERE provider = 'GITHUB' AND delivery_id = $1`,
        [input.deliveryId],
      );
      return { replayed, event };
    } catch (error) {
      await this.database.query(
        `UPDATE webhook_deliveries SET status = 'FAILED', last_error = $2
         WHERE provider = 'GITHUB' AND delivery_id = $1`,
        [
          input.deliveryId,
          error instanceof Error
            ? error.message.slice(0, 1_000)
            : 'Unknown error',
        ],
      );
      throw error;
    }
  }
}
