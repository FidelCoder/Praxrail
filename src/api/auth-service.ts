import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { actorRoleSchema, type ActorRole, type ApiActor } from '@praxrail/core';
import { AuthenticationError, NotFoundError } from '../domain/errors.js';
import type { Database } from '../persistence/database.js';

interface ActorRow {
  identity_id: string;
  token_id: string;
  actor_id: string;
  role: ActorRole;
  project_ids: string[];
}

function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function tokenValue(): string {
  return `pxr_${randomBytes(32).toString('base64url')}`;
}

function mapActor(row: ActorRow): ApiActor {
  return {
    identityId: row.identity_id,
    tokenId: row.token_id,
    actorId: row.actor_id,
    role: actorRoleSchema.parse(row.role),
    projectIds: row.project_ids,
  };
}

export class ApiAuthService {
  constructor(private readonly database: Database) {}

  async provisionBootstrap(input: {
    token: string;
    actorId: string;
    role: ActorRole;
    projectIds?: string[];
  }): Promise<void> {
    if (input.token.length < 32)
      throw new Error('Bootstrap API token is too short');
    await this.database.transaction(async (client) => {
      const identityId = randomUUID();
      const identity = await client.query<{ id: string }>(
        `INSERT INTO api_identities (id, actor_id, role, project_ids)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (actor_id, role) DO UPDATE SET
           project_ids = EXCLUDED.project_ids, status = 'ACTIVE', updated_at = now()
         RETURNING id`,
        [identityId, input.actorId, input.role, input.projectIds ?? []],
      );
      const id = identity.rows[0]?.id;
      if (!id) throw new Error('Bootstrap identity was not returned');
      const token = await client.query(
        `INSERT INTO api_tokens (id, identity_id, token_digest, label)
         VALUES ($1, $2, $3, 'bootstrap')
         ON CONFLICT (token_digest) DO UPDATE SET
           revoked_at = NULL
         WHERE api_tokens.identity_id = EXCLUDED.identity_id
         RETURNING id`,
        [randomUUID(), id, digestToken(input.token)],
      );
      if (token.rowCount !== 1) {
        throw new Error('Bootstrap token belongs to another identity');
      }
    });
  }

  async authenticate(token: string): Promise<ApiActor> {
    if (token.length < 32) throw new AuthenticationError();
    const result = await this.database.query<ActorRow>(
      `UPDATE api_tokens AS token SET last_used_at = now()
       FROM api_identities AS identity
       WHERE token.token_digest = $1
         AND token.identity_id = identity.id
         AND token.revoked_at IS NULL
         AND (token.expires_at IS NULL OR token.expires_at > now())
         AND identity.status = 'ACTIVE'
       RETURNING identity.id AS identity_id, token.id AS token_id,
         identity.actor_id, identity.role, identity.project_ids`,
      [digestToken(token)],
    );
    const row = result.rows[0];
    if (!row) throw new AuthenticationError();
    return mapActor(row);
  }

  async rotate(actor: ApiActor): Promise<string> {
    const token = tokenValue();
    await this.database.transaction(async (client) => {
      const revoked = await client.query(
        `UPDATE api_tokens SET revoked_at = now()
         WHERE id = $1 AND identity_id = $2 AND revoked_at IS NULL`,
        [actor.tokenId, actor.identityId],
      );
      if (revoked.rowCount !== 1)
        throw new NotFoundError('API token was not found');
      await client.query(
        `INSERT INTO api_tokens (id, identity_id, token_digest, label)
         VALUES ($1, $2, $3, 'rotated')`,
        [randomUUID(), actor.identityId, digestToken(token)],
      );
    });
    return token;
  }

  async revoke(actor: ApiActor): Promise<void> {
    const result = await this.database.query(
      `UPDATE api_tokens SET revoked_at = now()
       WHERE id = $1 AND identity_id = $2 AND revoked_at IS NULL`,
      [actor.tokenId, actor.identityId],
    );
    if (result.rowCount !== 1)
      throw new NotFoundError('API token was not found');
  }
}
