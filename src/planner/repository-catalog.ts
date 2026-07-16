import type { Database } from '../persistence/database.js';

export interface ManagedRepository {
  id: string;
  projectId: string;
  fullName: string;
  workerProfile: string;
  verificationCommands: string[];
}

interface RepositoryRow {
  id: string;
  project_id: string;
  full_name: string;
  worker_profile: string;
  verification_commands: unknown;
}

function parseCommands(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Repository verification commands are invalid');
  }
  const commands: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error('Repository verification commands are invalid');
    }
    commands.push(entry);
  }
  return commands;
}

export class RepositoryCatalog {
  constructor(private readonly database: Database) {}

  async enabled(): Promise<ManagedRepository[]> {
    const result = await this.database.query<RepositoryRow>(
      `SELECT id, project_id, full_name, worker_profile, verification_commands
       FROM repositories WHERE enabled = true ORDER BY full_name`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      fullName: row.full_name,
      workerProfile: row.worker_profile,
      verificationCommands: parseCommands(row.verification_commands),
    }));
  }
}
