import type { Database } from '../persistence/database.js';

interface LeaseRow {
  resource_type: string;
  resource_id: string;
  worker_id: string;
  fencing_token: string;
  expires_at: Date;
}

export interface WorkerLease {
  resourceType: string;
  resourceId: string;
  workerId: string;
  fencingToken: bigint;
  expiresAt: Date;
}

function mapLease(row: LeaseRow): WorkerLease {
  return {
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    workerId: row.worker_id,
    fencingToken: BigInt(row.fencing_token),
    expiresAt: row.expires_at,
  };
}

export class WorkerLeaseService {
  constructor(private readonly database: Database) {}

  async acquire(
    resourceType: string,
    resourceId: string,
    workerId: string,
    leaseMilliseconds: number,
  ): Promise<WorkerLease | null> {
    const expiresAt = new Date(Date.now() + leaseMilliseconds);
    const result = await this.database.query<LeaseRow>(
      `INSERT INTO worker_leases
        (resource_type, resource_id, worker_id, fencing_token, expires_at)
       VALUES ($1, $2, $3, nextval('fencing_token_sequence'), $4)
       ON CONFLICT (resource_type, resource_id) DO UPDATE SET
         worker_id = EXCLUDED.worker_id,
         fencing_token = nextval('fencing_token_sequence'),
         expires_at = EXCLUDED.expires_at,
         heartbeat_at = now(),
         created_at = now()
       WHERE worker_leases.expires_at <= now()
       RETURNING resource_type, resource_id, worker_id, fencing_token::text, expires_at`,
      [resourceType, resourceId, workerId, expiresAt],
    );
    const row = result.rows[0];
    return row ? mapLease(row) : null;
  }

  async heartbeat(
    lease: WorkerLease,
    leaseMilliseconds: number,
  ): Promise<WorkerLease | null> {
    const expiresAt = new Date(Date.now() + leaseMilliseconds);
    const result = await this.database.query<LeaseRow>(
      `UPDATE worker_leases SET expires_at = $5, heartbeat_at = now()
       WHERE resource_type = $1 AND resource_id = $2 AND worker_id = $3
         AND fencing_token = $4 AND expires_at > now()
       RETURNING resource_type, resource_id, worker_id, fencing_token::text, expires_at`,
      [
        lease.resourceType,
        lease.resourceId,
        lease.workerId,
        lease.fencingToken.toString(),
        expiresAt,
      ],
    );
    const row = result.rows[0];
    return row ? mapLease(row) : null;
  }
}
