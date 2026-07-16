import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../persistence/database.js';
import type {
  OutboxMessage,
  OutboxService,
} from '../services/outbox-service.js';

export const notificationEventSchema = z.enum([
  'ACCEPTED',
  'CLARIFICATION',
  'STARTED',
  'PULL_REQUEST',
  'CI_EXHAUSTED',
  'APPROVAL_REQUIRED',
  'MERGED',
  'BLOCKED',
  'ABANDONED',
  'ROLLED_BACK',
]);
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

const notificationPayloadSchema = z.object({
  taskId: z.uuid().optional(),
  taskKey: z.string().regex(/^PXR-(?:\d+|REPORT)$/),
  event: notificationEventSchema,
  text: z.string().min(1).max(4_000),
  link: z.url().optional(),
  destination: z.string().min(1).max(200),
});

export interface NotificationGateway {
  send(input: {
    destination: string;
    html: string;
    idempotencyKey: string;
  }): Promise<{ deliveryId: string }>;
}

export function escapeTelegramHtml(value: string): string {
  const printable = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code >= 32 ||
        character === '\n' ||
        character === '\r' ||
        character === '\t'
      );
    })
    .join('');
  return printable
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .slice(0, 3_500);
}

export class NotificationService {
  constructor(private readonly outbox: OutboxService) {}

  async queue(input: {
    taskId: string;
    taskKey: string;
    event: NotificationEvent;
    text: string;
    destination: string;
    link?: string;
    occurrence?: string;
  }): Promise<{ id: string; replayed: boolean }> {
    const payload = notificationPayloadSchema.parse(input);
    return this.outbox.enqueue({
      topic: 'notifications.telegram',
      aggregateType: 'task',
      aggregateId: input.taskId,
      idempotencyKey: [
        'telegram',
        input.taskId,
        input.event,
        input.occurrence ?? 'once',
      ].join(':'),
      payload,
    });
  }
}

export class NotificationDispatcher {
  constructor(
    private readonly database: Database,
    private readonly outbox: OutboxService,
    private readonly gateway: NotificationGateway,
  ) {}

  async deliverBatch(workerId: string, limit = 20): Promise<number> {
    const messages = await this.outbox.claim(
      workerId,
      limit,
      'notifications.telegram',
    );
    for (const message of messages) await this.deliver(message, workerId);
    return messages.length;
  }

  private async deliver(
    message: OutboxMessage,
    workerId: string,
  ): Promise<void> {
    const payload = notificationPayloadSchema.parse(message.payload);
    const deliveryId = randomUUID();
    const destinationDigest = createHash('sha256')
      .update(payload.destination)
      .digest('hex');
    const inserted = await this.database.query(
      `INSERT INTO notification_deliveries
        (id, task_id, provider, destination_digest, event_type,
         idempotency_key, payload, status, attempts)
       VALUES ($1, $2, 'TELEGRAM', $3, $4,
               $5, $6, 'SENDING', 1)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        deliveryId,
        payload.taskId ?? null,
        destinationDigest,
        payload.event,
        message.idempotencyKey,
        payload,
      ],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.database.query<{ status: string }>(
        'SELECT status FROM notification_deliveries WHERE idempotency_key = $1',
        [message.idempotencyKey],
      );
      if (['SENDING', 'SENT'].includes(existing.rows[0]?.status ?? '')) {
        await this.outbox.complete(message.id, workerId);
        return;
      }
      await this.database.query(
        `UPDATE notification_deliveries SET status = 'SENDING',
           attempts = attempts + 1, last_error = NULL
         WHERE idempotency_key = $1`,
        [message.idempotencyKey],
      );
    }
    try {
      const link = payload.link
        ? `\n<a href="${escapeTelegramHtml(payload.link)}">Open evidence</a>`
        : '';
      const sent = await this.gateway.send({
        destination: payload.destination,
        html: `<b>${escapeTelegramHtml(payload.taskKey)}</b> · ${escapeTelegramHtml(payload.event)}\n${escapeTelegramHtml(payload.text)}${link}`,
        idempotencyKey: message.idempotencyKey,
      });
      await this.database.query(
        `UPDATE notification_deliveries SET status = 'SENT',
           provider_delivery_id = $2, delivered_at = now()
         WHERE idempotency_key = $1`,
        [message.idempotencyKey, sent.deliveryId],
      );
      if (message.aggregateType === 'daily_report') {
        await this.database.query(
          `UPDATE daily_reports SET delivery_status = 'SENT',
             delivered_at = now() WHERE id = $1`,
          [message.aggregateId],
        );
      }
      await this.outbox.complete(message.id, workerId);
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message.slice(0, 1_000)
          : 'Delivery failed';
      await this.database.query(
        `UPDATE notification_deliveries SET status = 'FAILED', last_error = $2
         WHERE idempotency_key = $1`,
        [message.idempotencyKey, reason],
      );
      if (message.aggregateType === 'daily_report') {
        await this.database.query(
          `UPDATE daily_reports SET delivery_status = 'FAILED' WHERE id = $1`,
          [message.aggregateId],
        );
      }
      await this.outbox.fail(message.id, workerId, reason, 30_000);
    }
  }
}
