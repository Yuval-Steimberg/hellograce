import { Pool, type PoolClient } from 'pg';
import type { Env } from '../config/env.js';

export type DbPool = Pool;

export function createPool(env: Pick<Env, 'DATABASE_URL' | 'DATABASE_SSL'>): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function withClient<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
