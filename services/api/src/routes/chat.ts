import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { AIService } from '../services/ai.service.js';
import { ValidationError } from '../errors.js';

const ChatSchema = z.object({
  userId: z.string().min(1).max(120),
  text: z.string().min(1).max(4000),
});

/** Investor-friendly demo endpoint — bypasses Twilio entirely. */
export function registerChatRoutes(app: FastifyInstance, ai: AIService, pool?: Pool): void {
  app.post('/chat/send', async (req) => {
    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const { userId, text } = parsed.data;

    const result = await ai.handleMessage({
      userId,
      channel: 'sms',
      text,
      type: 'text',
      media: [],
      providerMessageId: `demo-${Date.now()}`,
      receivedAt: new Date(),
    });

    return {
      reply: result.text,
      intent: result.intent,
      confidence: result.confidence,
      latencyMs: result.latencyMs,
      toolResults: result.toolResults,
    };
  });

  /**
   * SSE endpoint for the admin dashboard — streams new messages for a conversation
   * as they land in the DB. Polls every 500 ms and pushes deltas as SSE events.
   */
  app.get('/chat/stream/:conversationId', async (req, reply) => {
    if (!pool) {
      reply.status(503).send({ error: 'STREAM_UNAVAILABLE', message: 'Streaming requires DB pool' });
      return;
    }

    const { conversationId } = req.params as { conversationId: string };
    const raw = reply.raw;

    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'keep-alive');
    raw.setHeader('X-Accel-Buffering', 'no');
    raw.flushHeaders();

    let lastSeenId: string | null = null;
    let closed = false;

    req.raw.on('close', () => {
      closed = true;
    });

    const send = (event: string, data: unknown) => {
      if (closed) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('connected', { conversationId });

    const poll = async () => {
      if (closed) return;
      try {
        const { rows } = await pool.query<{ id: string; role: string; content: string; created_at: Date }>(
          `SELECT id, role, content, created_at FROM messages
           WHERE conversation_id = $1
           ${lastSeenId ? 'AND id > $2' : ''}
           ORDER BY created_at ASC
           LIMIT 50`,
          lastSeenId ? [conversationId, lastSeenId] : [conversationId],
        );
        for (const row of rows) {
          send('message', row);
          lastSeenId = row.id;
        }
      } catch {
        // swallow transient DB errors; client will reconnect
      }

      if (!closed) setTimeout(() => void poll(), 500);
    };

    void poll();

    // Fastify needs a never-resolving promise for SSE routes.
    await new Promise<void>((resolve) => {
      req.raw.on('close', resolve);
    });
  });

  /** Chat history for a user (most recent 100 messages). */
  app.get('/chat/history/:userId', async (req) => {
    if (!pool) return { messages: [] };
    const { userId } = req.params as { userId: string };
    const { rows } = await pool.query(
      `SELECT m.id, m.role, m.content, m.created_at, c.id AS conversation_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.user_id = $1
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [userId],
    );
    return { messages: rows.reverse() };
  });
}
