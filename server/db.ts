import pg from 'pg';
import { config } from './config';
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 4 });
export const privatePool = new pg.Pool({ connectionString: config.PRIVATE_DATABASE_URL, max: 1 });
export async function transaction<T>(fn: (c: pg.PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
