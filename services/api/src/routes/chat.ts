import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AIService } from '../services/ai.service.js';
import { ValidationError } from '../errors.js';

const ChatSchema = z.object({
  userId: z.string().min(1).max(120),
  text: z.string().min(1).max(4000),
});

/** Investor-friendly demo endpoint — bypasses Twilio entirely. */
export function registerChatRoutes(app: FastifyInstance, ai: AIService): void {
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
}
