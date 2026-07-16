import path from 'node:path';
import { Database } from '../src/persistence/database.js';
import { migrate } from '../src/persistence/migrator.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is required');
}

const target = new URL(connectionString);
const databaseName = target.pathname.slice(1);
if (
  !['localhost', '127.0.0.1', 'postgres'].includes(target.hostname) ||
  !databaseName.endsWith('_test')
) {
  throw new Error(
    'Refusing to reset a database unless it is local and its name ends with _test',
  );
}

const database = new Database({
  url: connectionString,
  ssl: false,
  migrationsDir: path.resolve('migrations'),
});

try {
  await database.query('DROP SCHEMA public CASCADE');
  await database.query('CREATE SCHEMA public');
  const applied = await migrate(database, path.resolve('migrations'));
  process.stdout.write(
    `Reset ${databaseName}; applied ${applied.length} migrations\n`,
  );
} finally {
  await database.close();
}
