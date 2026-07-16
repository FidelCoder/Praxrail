import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { Database } from '../src/persistence/database.js';
import { migrate } from '../src/persistence/migrator.js';

const config = loadConfig();
if (config.environment === 'production') {
  throw new Error('Development seed is disabled in production');
}

const database = new Database(config.database);
try {
  await migrate(database, config.database.migrationsDir);
  await database.query(
    `INSERT INTO projects (id, slug, name)
     VALUES ($1, 'praxrail-sandbox', 'Praxrail Sandbox')
     ON CONFLICT (slug) DO UPDATE SET updated_at = now()`,
    [randomUUID()],
  );
  process.stdout.write('Seeded Praxrail Sandbox project\n');
} finally {
  await database.close();
}
