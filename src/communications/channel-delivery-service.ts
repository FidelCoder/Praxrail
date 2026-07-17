import { createHash, randomUUID } from 'node:crypto';
import { notificationEventSchema, type NotificationEvent } from 'praxrail-core';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Database } from '../persistence/database.js';
import {
  type OutboxMessage,
  type OutboxService,
} from '../services/outbox-service.js';

export type CommunicationChannel = 'EMAIL' | 'TELEGRAM';

export interface ChannelGateway {
  send(input: {
    destination: string;
    subject: string;
    text: string;
    html: string;
    idempotencyKey: string;
    threadReference?: string | undefined;
  }): Promise<{ deliveryId: string; threadReference?: string | undefined }>;
}

const verificationPayloadSchema = z.object({
  kind: z.literal('IDENTITY_VERIFICATION'),
  channel: z.enum(['EMAIL', 'TELEGRAM']),
  destination: z.string().min(1).max(500),
  verificationCode: z.string().min(16).max(200),
  expiresAt: z.iso.datetime(),
});

const notificationPayloadSchema = z.object({
  kind: z.literal('NOTIFICATION'),
  channel: z.enum(['EMAIL', 'TELEGRAM']),
  channelIdentityId: z.uuid(),
  destination: z.string().min(1).max(500),
  event: notificationEventSchema,
  subject: z.string().min(1).max(200),
  text: z.string().min(1).max(4_000),
  html: z.string().min(1).max(8_000),
  threadReference: z.string().min(1).max(500).optional(),
});

const deliveryPayloadSchema = z.discriminatedUnion('kind', [
  verificationPayloadSchema,
  notificationPayloadSchema,
]);
const severityRank = {
  INFO: 0,
  ACTION_REQUIRED: 1,
  WARNING: 2,
  CRITICAL: 3,
} as const;

function boundedText(value: string, maximum = 3_500): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 || ['\n', '\r', '\t'].includes(character);
    })
    .join('')
    .replaceAll(/(?:https?:\/\/)?[^\s]+:[^\s]+@/g, '[redacted]@')
    .slice(0, maximum);
}

function escapeHtml(value: string): string {
  return boundedText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function render(event: NotificationEvent): {
  subject: string;
  text: string;
  html: string;
} {
  const title = boundedText(event.title, 160);
  const summary = boundedText(event.summary, 2_000);
  const taskHint = event.taskId
    ? `\n\nTerminal: praxrail task status ${event.taskId}`
    : '';
  const actionHint =
    event.action && event.taskId
      ? `\nRemote action: ${event.action.toLowerCase()}`
      : '';
  const text = `${title}\n\n${summary}${actionHint}${taskHint}`.slice(0, 4_000);
  return {
    subject: `[Praxrail] ${title}`.slice(0, 200),
    text,
    html: [
      `<strong>${escapeHtml(title)}</strong>`,
      `<p>${escapeHtml(summary).replaceAll('\n', '<br>')}</p>`,
      event.action
        ? `<p>Action: <code>${escapeHtml(event.action)}</code></p>`
        : '',
      event.taskId
        ? `<p>Terminal: <code>praxrail task status ${escapeHtml(event.taskId)}</code></p>`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 8_000),
  };
}

function inQuietHours(input: {
  timezone: string;
  start: string | null;
  end: string | null;
  now?: Date;
}): boolean {
  if (!input.start || !input.end) return false;
  const local = DateTime.fromJSDate(input.now ?? new Date(), {
    zone: input.timezone,
  });
  if (!local.isValid) return false;
  const minute = local.hour * 60 + local.minute;
  const [startHour = 0, startMinute = 0] = input.start.split(':').map(Number);
  const [endHour = 0, endMinute = 0] = input.end.split(':').map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return start <= end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

interface RecipientRow {
  id: string;
  channel: CommunicationChannel;
  destination: string;
  minimum_severity: keyof typeof severityRank;
  delivery_mode: 'IMMEDIATE' | 'DIGEST' | 'MUTED';
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string;
}

export class ChannelDeliveryService {
  constructor(
    private readonly database: Database,
    private readonly outbox: OutboxService,
    private readonly gateways: Partial<
      Record<CommunicationChannel, ChannelGateway>
    >,
  ) {}

  async queue(eventInput: NotificationEvent): Promise<number> {
    const event = notificationEventSchema.parse(eventInput);
    const rendered = render(event);
    const recipients = await this.database.query<RecipientRow>(
      `SELECT identity.id, identity.channel, identity.destination,
              COALESCE(preference.minimum_severity, 'INFO') AS minimum_severity,
              COALESCE(preference.delivery_mode, 'IMMEDIATE') AS delivery_mode,
              preference.quiet_hours_start::text,
              preference.quiet_hours_end::text,
              COALESCE(preference.timezone, 'UTC') AS timezone
       FROM channel_identities AS identity
       LEFT JOIN LATERAL (
         SELECT minimum_severity, delivery_mode, quiet_hours_start,
                quiet_hours_end, timezone
         FROM channel_preferences
         WHERE identity_id = identity.identity_id
           AND channel = identity.channel
           AND (project_id = $1 OR project_id IS NULL)
         ORDER BY project_id NULLS LAST LIMIT 1
       ) AS preference ON true
       WHERE identity.status = 'VERIFIED'
         AND ($1::uuid IS NULL OR identity.project_id IS NULL
              OR identity.project_id = $1)`,
      [event.projectId],
    );
    let queued = 0;
    for (const recipient of recipients.rows) {
      if (recipient.delivery_mode === 'MUTED') continue;
      if (
        severityRank[event.severity] < severityRank[recipient.minimum_severity]
      ) {
        continue;
      }
      const quiet = inQuietHours({
        timezone: recipient.timezone,
        start: recipient.quiet_hours_start?.slice(0, 5) ?? null,
        end: recipient.quiet_hours_end?.slice(0, 5) ?? null,
      });
      if (quiet && event.severity !== 'CRITICAL') continue;
      const topic = ['channel', recipient.channel.toLowerCase()].join('.');
      await this.outbox.enqueue({
        topic,
        aggregateType: event.taskId ? 'task' : 'runtime',
        aggregateId: event.taskId ?? event.eventId,
        idempotencyKey: [
          'notify',
          event.eventId,
          recipient.channel,
          recipient.id,
        ].join(':'),
        payload: {
          kind: 'NOTIFICATION',
          channel: recipient.channel,
          channelIdentityId: recipient.id,
          destination: recipient.destination,
          event,
          ...rendered,
        },
      });
      queued += 1;
    }
    return queued;
  }

  async deliverBatch(
    channel: CommunicationChannel,
    workerId: string,
    limit = 20,
  ): Promise<number> {
    const topic = ['channel', channel.toLowerCase()].join('.');
    const messages = await this.outbox.claim(workerId, limit, topic);
    for (const message of messages) {
      await this.deliver(channel, message, workerId);
    }
    return messages.length;
  }

  private async deliver(
    channel: CommunicationChannel,
    message: OutboxMessage,
    workerId: string,
  ): Promise<void> {
    const payload = deliveryPayloadSchema.parse(message.payload);
    if (payload.channel !== channel) {
      await this.outbox.fail(
        message.id,
        workerId,
        'Channel payload mismatch',
        300_000,
      );
      return;
    }
    const state = await this.database.query<{
      enabled: boolean;
      circuit_open_until: Date | null;
    }>(
      `SELECT enabled, circuit_open_until FROM connector_states
       WHERE channel = $1`,
      [channel],
    );
    const connector = state.rows[0];
    if (
      !connector?.enabled ||
      (connector.circuit_open_until &&
        connector.circuit_open_until > new Date())
    ) {
      await this.outbox.fail(
        message.id,
        workerId,
        'Connector is disabled or circuit is open',
        60_000,
      );
      return;
    }
    const gateway = this.gateways[channel];
    if (!gateway) {
      await this.outbox.fail(
        message.id,
        workerId,
        'Connector gateway is unavailable',
        300_000,
      );
      return;
    }
    const destinationDigest = createHash('sha256')
      .update(payload.destination)
      .digest('hex');
    const deliveryId = randomUUID();
    const inserted = await this.database.query(
      `INSERT INTO notification_deliveries
        (id, task_id, provider, destination_digest, event_type,
         idempotency_key, payload, status, attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'SENDING', 1)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        deliveryId,
        payload.kind === 'NOTIFICATION' ? payload.event.taskId : null,
        channel,
        destinationDigest,
        payload.kind,
        message.idempotencyKey,
        {
          kind: payload.kind,
          channel,
          ...(payload.kind === 'NOTIFICATION'
            ? {
                eventId: payload.event.eventId,
                severity: payload.event.severity,
              }
            : { expiresAt: payload.expiresAt }),
        },
      ],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.database.query<{ status: string }>(
        `SELECT status FROM notification_deliveries
         WHERE idempotency_key = $1`,
        [message.idempotencyKey],
      );
      if (existing.rows[0]?.status === 'SENT') {
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
    const content =
      payload.kind === 'NOTIFICATION'
        ? {
            subject: payload.subject,
            text: payload.text,
            html: payload.html,
            threadReference: payload.threadReference,
          }
        : {
            subject: '[Praxrail] Verify your channel',
            text: `Praxrail verification code: ${payload.verificationCode}\nExpires: ${payload.expiresAt}`,
            html: `<strong>Praxrail verification</strong><p>Code: <code>${escapeHtml(payload.verificationCode)}</code></p><p>Expires: ${escapeHtml(payload.expiresAt)}</p>`,
          };
    try {
      const sent = await gateway.send({
        destination: payload.destination,
        ...content,
        idempotencyKey: message.idempotencyKey,
      });
      await this.database.transaction(async (client) => {
        await client.query(
          `UPDATE notification_deliveries SET status = 'SENT',
             provider_delivery_id = $2, delivered_at = now()
           WHERE idempotency_key = $1`,
          [message.idempotencyKey, boundedText(sent.deliveryId, 500)],
        );
        await client.query(
          `UPDATE connector_states SET failure_count = 0,
             circuit_open_until = NULL, last_success_at = now(),
             updated_at = now() WHERE channel = $1`,
          [channel],
        );
      });
      await this.outbox.complete(message.id, workerId);
    } catch (error) {
      const failure = boundedText(
        error instanceof Error ? error.message : 'Provider delivery failed',
        500,
      );
      await this.database.transaction(async (client) => {
        await client.query(
          `UPDATE notification_deliveries SET status = 'FAILED',
             last_error = $2 WHERE idempotency_key = $1`,
          [message.idempotencyKey, failure],
        );
        await client.query(
          `UPDATE connector_states SET failure_count = failure_count + 1,
             last_failure_at = now(),
             circuit_open_until = CASE WHEN failure_count + 1 >= 5
               THEN now() + interval '5 minutes' ELSE circuit_open_until END,
             updated_at = now() WHERE channel = $1`,
          [channel],
        );
      });
      await this.outbox.fail(message.id, workerId, failure, 30_000);
    }
  }
}

export { inQuietHours, render as renderChannelEvent };
