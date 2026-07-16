import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { Database } from '../../persistence/database.js';
import { IncomingMessageService } from '../../services/incoming-message-service.js';
import type { TaskRecord, TaskService } from '../../services/task-service.js';

const attachmentSchema = z.object({
  filename: z.string().min(1).max(200),
  mediaType: z.enum([
    'text/plain',
    'text/markdown',
    'application/json',
    'application/pdf',
    'image/png',
    'image/jpeg',
  ]),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(10 * 1024 * 1024),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  scanStatus: z.literal('CLEAN'),
});

export const authenticatedEmailSchema = z.object({
  provider: z.string().min(1).max(40),
  externalMessageId: z.string().min(1).max(500),
  externalThreadId: z.string().min(1).max(500),
  sender: z.email(),
  subject: z.string().min(5).max(500),
  body: z.string().min(1).max(100_000),
  authentication: z.object({
    spf: z.literal('PASS'),
    dkim: z.literal('PASS'),
    dmarc: z.literal('PASS'),
    alignedFrom: z.literal(true),
  }),
  attachments: z.array(attachmentSchema).max(20).default([]),
});

export type AuthenticatedEmail = z.infer<typeof authenticatedEmailSchema>;

const dangerousExtension =
  /\.(?:app|bat|cmd|com|dll|dmg|exe|hta|jar|js|lnk|msi|ps1|scr|sh|vbs)$/i;

function normalizeSender(sender: string): string {
  return sender.trim().toLowerCase();
}

function senderDigest(sender: string): string {
  return createHash('sha256').update(normalizeSender(sender)).digest('hex');
}

function taskKeyFromSubject(subject: string): string | null {
  return /\[(PXR-\d+)\]/i.exec(subject)?.[1]?.toUpperCase() ?? null;
}

function validateAttachments(
  attachments: AuthenticatedEmail['attachments'],
): void {
  const total = attachments.reduce(
    (sum, attachment) => sum + attachment.sizeBytes,
    0,
  );
  if (total > 25 * 1024 * 1024) {
    throw new Error('Email attachments exceed the total size limit');
  }
  for (const attachment of attachments) {
    if (
      path.basename(attachment.filename) !== attachment.filename ||
      dangerousExtension.test(attachment.filename)
    ) {
      throw new Error('Email attachment filename is unsafe');
    }
  }
}

interface ThreadRow {
  id: string;
  task_id: string | null;
  sender_digest: string;
}

export class EmailIntakeService {
  private readonly messages: IncomingMessageService;
  private readonly allowedSenders: ReadonlySet<string>;

  constructor(
    private readonly database: Database,
    private readonly tasks: TaskService,
    allowedSenders: Iterable<string>,
  ) {
    this.messages = new IncomingMessageService(database);
    this.allowedSenders = new Set(Array.from(allowedSenders, normalizeSender));
  }

  async ingest(value: unknown): Promise<{
    task: TaskRecord;
    replayed: boolean;
    correlated: boolean;
  }> {
    const input = authenticatedEmailSchema.parse(value);
    const sender = normalizeSender(input.sender);
    if (!this.allowedSenders.has(sender)) {
      throw new Error('Email sender is not authorized');
    }
    validateAttachments(input.attachments);
    const digest = senderDigest(sender);
    const threadResult = await this.database.query<ThreadRow>(
      `SELECT id, task_id, sender_digest FROM email_threads
       WHERE provider = $1 AND external_thread_id = $2`,
      [input.provider, input.externalThreadId],
    );
    const thread = threadResult.rows[0];
    if (thread && thread.sender_digest !== digest) {
      throw new Error(
        'Email thread sender does not match the authenticated sender',
      );
    }
    const subjectTaskKey = taskKeyFromSubject(input.subject);
    const subjectTask = subjectTaskKey
      ? (
          await this.database.query<{ id: string }>(
            'SELECT id FROM tasks WHERE task_key = $1',
            [subjectTaskKey],
          )
        ).rows[0]?.id
      : undefined;
    if (subjectTaskKey && !subjectTask) {
      throw new Error('Email subject references an unknown task');
    }
    if (thread?.task_id && subjectTask && thread.task_id !== subjectTask) {
      throw new Error('Email subject task does not match the existing thread');
    }
    const correlatedTaskId = thread?.task_id ?? subjectTask;
    if (correlatedTaskId) {
      const task = await this.tasks.getTask(correlatedTaskId);
      const correlationId = randomUUID();
      const message = await this.messages.record({
        provider: 'EMAIL',
        externalId: input.externalMessageId,
        senderId: digest,
        chatOrThreadId: input.externalThreadId,
        envelope: {
          provider: input.provider,
          subject: input.subject,
          authentication: input.authentication,
        },
        body: input.body,
        correlationId,
        authenticated: true,
      });
      await this.database.transaction(async (client) => {
        await client.query(
          'UPDATE incoming_messages SET task_id = $2 WHERE id = $1',
          [message.id, task.id],
        );
        if (!message.replayed) {
          await client.query(
            `INSERT INTO task_events
              (task_id, event_type, actor_type, actor_id, correlation_id, payload)
             VALUES ($1, 'EMAIL_REPLY_RECEIVED', 'OWNER', $2, $3, $4)`,
            [task.id, digest, correlationId, { messageId: message.id }],
          );
        }
        await client.query(
          `INSERT INTO email_threads
            (id, provider, external_thread_id, sender_digest, task_id,
             last_message_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (provider, external_thread_id) DO UPDATE
             SET last_message_id = EXCLUDED.last_message_id,
                 updated_at = now()`,
          [
            thread?.id ?? randomUUID(),
            input.provider,
            input.externalThreadId,
            digest,
            task.id,
            input.externalMessageId,
          ],
        );
      });
      await this.recordAttachments(thread?.id, input);
      return { task, replayed: message.replayed, correlated: true };
    }
    const created = await this.tasks.createInboxTask({
      provider: 'EMAIL',
      externalMessageId: input.externalMessageId,
      senderId: digest,
      chatOrThreadId: input.externalThreadId,
      authenticated: true,
      envelope: {
        provider: input.provider,
        subject: input.subject,
        authentication: input.authentication,
      },
      messageText: input.body,
      title: input.subject.replace(/^\s*(?:re|fwd):\s*/i, '').slice(0, 180),
      actorType: 'OWNER',
      actorId: digest,
    });
    const threadId = randomUUID();
    await this.database.query(
      `INSERT INTO email_threads
        (id, provider, external_thread_id, sender_digest, task_id, last_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, external_thread_id) DO NOTHING`,
      [
        threadId,
        input.provider,
        input.externalThreadId,
        digest,
        created.task.id,
        input.externalMessageId,
      ],
    );
    await this.recordAttachments(threadId, input);
    return {
      task: created.task,
      replayed: created.replayed,
      correlated: false,
    };
  }

  private async recordAttachments(
    knownThreadId: string | undefined,
    input: AuthenticatedEmail,
  ): Promise<void> {
    if (input.attachments.length === 0) return;
    const threadId =
      knownThreadId ??
      (
        await this.database.query<{ id: string }>(
          `SELECT id FROM email_threads
           WHERE provider = $1 AND external_thread_id = $2`,
          [input.provider, input.externalThreadId],
        )
      ).rows[0]?.id;
    if (!threadId) throw new Error('Email thread was not found');
    for (const attachment of input.attachments) {
      await this.database.query(
        `INSERT INTO email_attachments
          (id, email_thread_id, external_message_id, filename, media_type,
           size_bytes, digest, scan_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'CLEAN')
         ON CONFLICT (email_thread_id, external_message_id, digest) DO NOTHING`,
        [
          randomUUID(),
          threadId,
          input.externalMessageId,
          attachment.filename,
          attachment.mediaType,
          attachment.sizeBytes,
          attachment.digest,
        ],
      );
    }
  }
}
