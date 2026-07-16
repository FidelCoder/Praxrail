import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../persistence/database.js';

export class IncomingMessageService {
  constructor(private readonly database: Database) {}

  async record(input: {
    provider: 'TELEGRAM' | 'EMAIL' | 'GITHUB';
    externalId: string;
    senderId: string;
    chatOrThreadId?: string;
    envelope: Record<string, unknown>;
    body: string;
    correlationId: string;
    authenticated?: boolean;
  }): Promise<{ id: string; replayed: boolean }> {
    const id = randomUUID();
    const digest = createHash('sha256')
      .update(input.body, 'utf8')
      .digest('hex');
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO incoming_messages
        (id, provider, external_id, sender_id, chat_or_thread_id, correlation_id,
         authenticated, envelope, body_digest, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (provider, external_id) DO NOTHING
       RETURNING id`,
      [
        id,
        input.provider,
        input.externalId,
        input.senderId,
        input.chatOrThreadId ?? null,
        input.correlationId,
        input.authenticated ?? true,
        input.envelope,
        digest,
      ],
    );
    if (result.rowCount === 1) return { id, replayed: false };
    const existing = await this.database.query<{ id: string }>(
      'SELECT id FROM incoming_messages WHERE provider = $1 AND external_id = $2',
      [input.provider, input.externalId],
    );
    const existingId = existing.rows[0]?.id;
    if (!existingId)
      throw new Error('Incoming message conflict returned no record');
    return { id: existingId, replayed: true };
  }
}
