import { randomUUID } from 'node:crypto';
import {
  approvalActionSchema,
  approvalTokenMatches,
  issueApprovalToken,
  type ApprovalAction,
} from '../domain/approval.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import type { Database } from '../persistence/database.js';

interface ApprovalRow {
  id: string;
  task_id: string;
  action: ApprovalAction;
  requested_actor_id: string;
  token_digest: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'REVOKED';
  expires_at: Date;
}

export class ApprovalService {
  constructor(private readonly database: Database) {}

  async request(
    taskId: string,
    action: ApprovalAction,
    requestedActorId: string,
    reason: string,
  ): Promise<{ approvalId: string; token: string; expiresAt: Date }> {
    approvalActionSchema.parse(action);
    const approvalId = randomUUID();
    const issued = issueApprovalToken();
    await this.database.query(
      `INSERT INTO approvals
        (id, task_id, action, requested_actor_id, token_digest, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        approvalId,
        taskId,
        action,
        requestedActorId,
        issued.tokenDigest,
        reason,
        issued.expiresAt,
      ],
    );
    return { approvalId, token: issued.rawToken, expiresAt: issued.expiresAt };
  }

  async decide(input: {
    approvalId: string;
    actorId: string;
    token: string;
    approved: boolean;
    reason: string;
    now?: Date;
  }): Promise<void> {
    const outcome = await this.database.transaction(async (client) => {
      const result = await client.query<ApprovalRow>(
        `SELECT id, task_id, action, requested_actor_id, token_digest, status, expires_at
         FROM approvals WHERE id = $1 FOR UPDATE`,
        [input.approvalId],
      );
      const approval = result.rows[0];
      if (!approval) throw new NotFoundError('Approval was not found');
      if (approval.status !== 'PENDING')
        throw new ConflictError('Approval is no longer pending');
      if (approval.requested_actor_id !== input.actorId) {
        throw new ConflictError('Approval is bound to a different actor');
      }
      const now = input.now ?? new Date();
      if (approval.expires_at <= now) {
        await client.query(
          "UPDATE approvals SET status = 'EXPIRED', decided_at = $2 WHERE id = $1",
          [approval.id, now],
        );
        return 'EXPIRED' as const;
      }
      if (!approvalTokenMatches(input.token, approval.token_digest)) {
        throw new ConflictError('Approval token is invalid');
      }
      await client.query(
        `UPDATE approvals SET status = $2, decided_at = $3, decision_reason = $4
         WHERE id = $1`,
        [
          approval.id,
          input.approved ? 'APPROVED' : 'REJECTED',
          now,
          input.reason,
        ],
      );
      return 'DECIDED' as const;
    });
    if (outcome === 'EXPIRED') {
      throw new ConflictError('Approval has expired');
    }
  }
}
