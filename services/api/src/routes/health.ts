import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export function registerHealthRoutes(app: FastifyInstance, pool: Pool): void {
  // Build/version marker so you can confirm the RUNNING code is the code you
  // just deployed. `version` = the git commit baked in at build time (Dockerfile
  // ARG GIT_COMMIT); `machine` = Fly's per-deploy machine version (changes on
  // every deploy even if GIT_COMMIT wasn't passed). Either one flipping proves a
  // fresh deploy shipped.
  const version = process.env['GIT_COMMIT'] ?? 'unknown';
  const machine = process.env['FLY_MACHINE_VERSION'] ?? null;
  app.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    version,
    ...(machine ? { machine } : {}),
  }));

  app.get('/ready', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch (err) {
      app.log.warn({ err }, 'ready.db.failed');
      return reply.status(503).send({ status: 'degraded', reason: 'database_unreachable' });
    }
  });
}
