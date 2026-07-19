import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerChatRoutes } from './chat.js';

describe('POST /chat/send shell paste guard', () => {
  it('rejects two joined send commands before diary mutation', async () => {
    const app = Fastify();
    const ai = { handleMessage: vi.fn() };
    registerChatRoutes(app, ai as never);

    const res = await app.inject({
      method: 'POST',
      url: '/chat/send',
      payload: {
        userId: '+972500009999',
        text: 'and broccoli with a little olive oil.send Can you give me a detailed meal plan?',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().intent).toBe('invalid_test_input');
    expect(res.json().reply).toMatch(/separate|own line/i);
    expect(ai.handleMessage).not.toHaveBeenCalled();
  });

  it('requires an admin token when local test mode is disabled', async () => {
    const app = Fastify();
    const ai = {
      handleMessage: vi.fn().mockResolvedValue({
        text: 'Hi',
        intent: 'chat',
        confidence: 'high',
        latencyMs: 1,
        toolResults: [],
      }),
    };
    registerChatRoutes(app, ai as never, undefined, undefined, {
      localTestMode: false,
      adminToken: 'test-admin-token',
    });

    const denied = await app.inject({
      method: 'POST',
      url: '/chat/send',
      payload: { userId: '+972500009999', text: 'hello' },
    });
    expect(denied.statusCode).toBe(401);
    expect(ai.handleMessage).not.toHaveBeenCalled();

    const allowed = await app.inject({
      method: 'POST',
      url: '/chat/send',
      headers: { authorization: 'Bearer test-admin-token' },
      payload: { userId: '+972500009999', text: 'hello' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(ai.handleMessage).toHaveBeenCalledOnce();
  });
});
