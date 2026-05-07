import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export function registerHealthRoutes(app: FastifyInstance, pool: Pool): void {
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/ready', async () => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch (err) {
      app.log.warn({ err }, 'ready.db.failed');
      return { status: 'degraded', reason: 'database_unreachable' };
    }
  });
}
