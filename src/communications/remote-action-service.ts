import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  remoteActionSchema,
  type ApiActor,
  type RemoteAction,
} from '@praxrail/core';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import type { Database } from '../persistence/database.js';
import type { ProductService } from '../product/product-service.js';
import type { ApprovalService } from '../services/approval-service.js';

export const normalizedRemoteActionSchema = z.object({
  channel: z.enum(['EMAIL', 'TELEGRAM']),
  externalMessageId: z.string().min(1).max(500),
  sender: z.string().min(1).max(500),
  threadReference: z.string().min(1).max(500).optional(),
  action: remoteActionSchema,
  task: z.string().min(1).max(200).optional(),
  grantToken: z.string().min(32).max(500).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type NormalizedRemoteAction = z.infer<
  typeof normalizedRemoteActionSchema
>;

interface ChannelActorRow {
  channel_identity_id: string;
  identity_id: string;
  actor_id: string;
  role: ApiActor['role'];
  project_ids: string[];
  project_id: string | null;
}

export class RemoteActionService {
  constructor(
    private readonly database: Database,
    private readonly product: ProductService,
    private readonly approvals: ApprovalService,
  ) {}

  async issueGrant(input: {
    channelIdentityId: string;
    taskId: string;
    action: Exclude<RemoteAction, 'TASK_CREATE' | 'STATUS'>;
    policyRevision: string;
    expiresInMilliseconds?: number | undefined;
  }): Promise<{ grantId: string; token: string; expiresAt: string }> {
    const duration = Math.max(
      60_000,
      Math.min(input.expiresInMilliseconds ?? 15 * 60_000, 24 * 60 * 60_000),
    );
    const token = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(token).digest('hex');
    const grantId = randomUUID();
    const expiresAt = new Date(Date.now() + duration);
    const inserted = await this.database.query(
      `INSERT INTO remote_action_grants
        (id, channel_identity_id, task_id, action, policy_revision,
         token_digest, expires_at)
       SELECT $1, identity.id, task.id, $4, $5, $6, $7
       FROM channel_identities AS identity
       JOIN tasks AS task ON task.id = $3
       WHERE identity.id = $2 AND identity.status = 'VERIFIED'
         AND (identity.project_id IS NULL
              OR identity.project_id = task.project_id)`,
      [
        grantId,
        input.channelIdentityId,
        input.taskId,
        input.action,
        input.policyRevision,
        digest,
        expiresAt,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new ConflictError(
        'Verified channel identity and task scope are required',
      );
    }
    return { grantId, token, expiresAt: expiresAt.toISOString() };
  }

  async execute(
    requestInput: NormalizedRemoteAction,
  ): Promise<Record<string, unknown>> {
    const request = normalizedRemoteActionSchema.parse(requestInput);
    const actor = await this.resolveActor(request.channel, request.sender);
    const messageId = await this.recordMessage(request);
    if (request.action === 'TASK_CREATE') {
      const task = await this.product.createTask(
        {
          title: this.payloadString(request.payload, 'title', 180),
          request: this.payloadString(request.payload, 'request', 10_000),
          projectId: this.payloadUuid(request.payload, 'projectId'),
          repositoryId: this.payloadUuid(request.payload, 'repositoryId'),
          priority: this.payloadOptionalInteger(
            request.payload,
            'priority',
            0,
            100,
          ),
          budgetUsd: this.payloadOptionalNumber(request.payload, 'budgetUsd'),
        },
        actor,
      );
      await this.bindMessage(messageId, task.id);
      return { action: request.action, task };
    }
    const reference = request.task;
    if (!reference) throw new ConflictError('Remote action requires a task');
    const task = await this.product.getTask(reference, actor);
    await this.bindMessage(messageId, task.id);
    if (request.action === 'STATUS') {
      return { action: request.action, task };
    }
    await this.consumeGrant({
      token: request.grantToken,
      channelIdentityId: actor.tokenId,
      taskId: task.id,
      action: request.action,
    });
    if (request.action === 'PAUSE' || request.action === 'RESUME') {
      const updated = await this.product.controlTask(
        task.id,
        { action: request.action === 'PAUSE' ? 'pause' : 'resume' },
        actor,
      );
      return { action: request.action, task: updated };
    }
    if (request.action === 'CLARIFY') {
      const updated = await this.product.controlTask(
        task.id,
        {
          action: 'clarify',
          reason: this.payloadString(request.payload, 'answer', 10_000),
        },
        actor,
      );
      return { action: request.action, task: updated };
    }
    const approvalId = this.payloadUuid(request.payload, 'approvalId');
    const approvalToken = this.payloadString(
      request.payload,
      'approvalToken',
      500,
    );
    await this.approvals.decide({
      approvalId,
      actorId: actor.actorId,
      token: approvalToken,
      approved: request.action === 'APPROVE',
      reason: this.payloadString(request.payload, 'reason', 1_000),
    });
    return { action: request.action, taskId: task.id, decided: true };
  }

  private async resolveActor(
    channel: 'EMAIL' | 'TELEGRAM',
    sender: string,
  ): Promise<ApiActor> {
    const digest = createHash('sha256')
      .update(sender.trim().toLowerCase())
      .digest('hex');
    const result = await this.database.query<ChannelActorRow>(
      `SELECT channel.id AS channel_identity_id,
              identity.id AS identity_id, identity.actor_id, identity.role,
              identity.project_ids, channel.project_id
       FROM channel_identities AS channel
       JOIN api_identities AS identity ON identity.id = channel.identity_id
       WHERE channel.channel = $1
         AND channel.external_identity_digest = $2
         AND channel.status = 'VERIFIED'
         AND channel.role = identity.role
         AND identity.status = 'ACTIVE'`,
      [channel, digest],
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError('Verified channel identity was not found');
    }
    return {
      identityId: row.identity_id,
      tokenId: row.channel_identity_id,
      actorId: row.actor_id,
      role: row.role,
      projectIds: row.project_id ? [row.project_id] : row.project_ids,
    };
  }

  private async recordMessage(
    request: NormalizedRemoteAction,
  ): Promise<string> {
    const id = randomUUID();
    const bodyDigest = createHash('sha256')
      .update(
        JSON.stringify({ action: request.action, payload: request.payload }),
      )
      .digest('hex');
    const inserted = await this.database.query(
      `INSERT INTO incoming_messages
        (id, provider, external_id, sender_id, chat_or_thread_id,
         correlation_id, authenticated, envelope, body_digest)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
       ON CONFLICT (provider, external_id) DO NOTHING`,
      [
        id,
        request.channel,
        request.externalMessageId,
        createHash('sha256').update(request.sender).digest('hex'),
        request.threadReference ?? null,
        randomUUID(),
        {
          action: request.action,
          hasGrant: Boolean(request.grantToken),
        },
        bodyDigest,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new ConflictError('Remote message is stale or replayed');
    }
    return id;
  }

  private async bindMessage(messageId: string, taskId: string): Promise<void> {
    await this.database.query(
      `UPDATE incoming_messages SET task_id = $2, processed_at = now()
       WHERE id = $1`,
      [messageId, taskId],
    );
  }

  private async consumeGrant(input: {
    token?: string | undefined;
    channelIdentityId: string;
    taskId: string;
    action: Exclude<RemoteAction, 'TASK_CREATE' | 'STATUS'>;
  }): Promise<void> {
    if (!input.token)
      throw new ConflictError('Remote action grant is required');
    const digest = createHash('sha256').update(input.token).digest('hex');
    const result = await this.database.query(
      `UPDATE remote_action_grants SET consumed_at = now()
       WHERE channel_identity_id = $1 AND task_id = $2 AND action = $3
         AND token_digest = $4 AND consumed_at IS NULL AND revoked_at IS NULL
         AND expires_at > now()`,
      [input.channelIdentityId, input.taskId, input.action, digest],
    );
    if (result.rowCount !== 1) {
      throw new ConflictError(
        'Remote action grant is invalid, stale, revoked, or replayed',
      );
    }
  }

  private payloadString(
    payload: Record<string, unknown>,
    key: string,
    maximum: number,
  ): string {
    const value = payload[key];
    if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
      throw new ConflictError(`${key} is required and must be bounded`);
    }
    return value.trim();
  }

  private payloadUuid(payload: Record<string, unknown>, key: string): string {
    return z.uuid().parse(payload[key]);
  }

  private payloadOptionalInteger(
    payload: Record<string, unknown>,
    key: string,
    minimum: number,
    maximum: number,
  ): number | undefined {
    const value = payload[key];
    if (value === undefined) return undefined;
    return z.number().int().min(minimum).max(maximum).parse(value);
  }

  private payloadOptionalNumber(
    payload: Record<string, unknown>,
    key: string,
  ): number | undefined {
    const value = payload[key];
    if (value === undefined) return undefined;
    return z.number().positive().parse(value);
  }
}
