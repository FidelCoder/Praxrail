import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from './database.js';

interface MigrationRecord {
  name: string;
  checksum: string;
}

function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function migrate(
  database: Database,
  directory: string,
): Promise<string[]> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const names = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const applied: string[] = [];

  for (const name of names) {
    const sql = await readFile(path.join(directory, name), 'utf8');
    const migrationChecksum = checksum(sql);
    const existing = await database.query<MigrationRecord>(
      'SELECT name, checksum FROM schema_migrations WHERE name = $1',
      [name],
    );

    if (existing.rowCount === 1) {
      if (existing.rows[0]?.checksum !== migrationChecksum) {
        throw new Error(`Applied migration ${name} has been modified`);
      }
      continue;
    }

    await database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [1_947_202_026]);
      const raced = await client.query<MigrationRecord>(
        'SELECT name, checksum FROM schema_migrations WHERE name = $1',
        [name],
      );
      if (raced.rowCount === 1) {
        if (raced.rows[0]?.checksum !== migrationChecksum) {
          throw new Error(`Applied migration ${name} has been modified`);
        }
        return;
      }
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [name, migrationChecksum],
      );
    });
    applied.push(name);
  }

  return applied;
}
