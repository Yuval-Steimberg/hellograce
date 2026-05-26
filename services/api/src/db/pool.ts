import { Pool, type PoolClient } from 'pg';
import type { Env } from '../config/env.js';

export type DbPool = Pool;

export function createPool(env: Pick<Env, 'DATABASE_URL' | 'DATABASE_SSL'>): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    // Supabase Transaction Pooler (Supavisor) doesn't chain to Node.js's default
    // trust store, so rejectUnauthorized must stay false even with SSL enabled.
    // The connection is still TLS-encrypted; just not CA-verified on our end.
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
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
