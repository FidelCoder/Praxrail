import pg from 'pg';
import type { AppConfig } from '../config.js';

const { Pool } = pg;

export type Queryable = Pick<pg.PoolClient, 'query'>;

export class Database {
  readonly pool: pg.Pool;

  constructor(config: AppConfig['database']) {
    this.pool = new Pool({
      connectionString: config.url,
      max: 10,
      application_name: 'praxrail',
      ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
      statement_timeout: 30_000,
      query_timeout: 35_000,
    });
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(text, [...values]);
  }

  async transaction<T>(
    operation: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
