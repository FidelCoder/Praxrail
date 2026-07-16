import { PgBoss } from 'pg-boss';
import { loadConfig } from '../src/config.js';
import { Database } from '../src/persistence/database.js';
import { migrate as migrateControlPlane } from '../src/persistence/migrator.js';

const config = loadConfig();
const database = new Database({
  ...config.database,
  url: config.database.migrationUrl ?? config.database.url,
});

try {
  const applied = await migrateControlPlane(
    database,
    config.database.migrationsDir,
  );
  const queueMigrator = new PgBoss({
    connectionString: config.database.migrationUrl ?? config.database.url,
    schema: 'praxrail_jobs',
    application_name: 'praxrail-jobs-migrator',
    useListenNotify: false,
    supervise: false,
    schedule: false,
  });
  await queueMigrator.start();
  await queueMigrator.stop({ graceful: true, timeout: 30_000 });
  await database.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'praxrail_app') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA praxrail_jobs TO praxrail_app';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA praxrail_jobs TO praxrail_app';
        EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA praxrail_jobs TO praxrail_app';
        EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA praxrail_jobs TO praxrail_app';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA praxrail_jobs GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO praxrail_app';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA praxrail_jobs GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO praxrail_app';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA praxrail_jobs GRANT EXECUTE ON FUNCTIONS TO praxrail_app';
      END IF;
    END
    $$
  `);
  process.stdout.write(
    applied.length > 0
      ? `Applied: ${applied.join(', ')}\n`
      : 'Database is current\n',
  );
} finally {
  await database.close();
}
