import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import { Scheduler } from './scheduler.js';
import { buildQuietReengagement } from './quiet-reengagement.js';
import type { UserService, GraceUser } from '../user/user.service.js';
import type { MessageSender } from '../twilio/sender.js';
import type { MessageGenerator } from './message-generator.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

describe('buildQuietReengagement — warm, no-pressure, respects opt-out', () => {
  it('greets by name and keeps reminders off, never nags', () => {
    const msg = buildQuietReengagement({ first_name: 'Yuval' }, 'seed-1');
    expect(msg).toMatch(/Yuval/);
    expect(msg.toLowerCase()).toMatch(/reminder/); // acknowledges reminders stay off
    expect(msg).toMatch(/🧡/);
    expect(msg).not.toMatch(/upgrade|subscribe|pay|trial|http/i); // no sales pressure
  });
  it('works without a name (no ciphertext leak)', () => {
    expect(buildQuietReengagement({ first_name: null }, 's')).toBeTruthy();
    expect(buildQuietReengagement({ first_name: 'enc:0a1b:2c3d:4e5f' }, 's')).not.toMatch(/enc:/);
  });
  it('is deterministic per seed but varies across seeds', () => {
    const a = buildQuietReengagement({ first_name: 'Sam' }, 'monday');
    expect(buildQuietReengagement({ first_name: 'Sam' }, 'monday')).toBe(a);
    const seeds = ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => buildQuietReengagement({ first_name: 'Sam' }, s));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
});

function makePausedUser(overrides: Partial<GraceUser> = {}): GraceUser {
  return {
    phone: '+15551230000',
    first_name: 'Quiet',
    timezone: 'America/New_York',
    paused: true,
    channel: 'imessage',
    last_reply_at: null,
    onboarding_state: null,
    ...overrides,
  } as unknown as GraceUser;
}

function buildHarness(paused: GraceUser[], opts: { minGapHours?: number; afterHours?: number } = {}) {
  const sends: Array<{ to: string; body: string; channel: string }> = [];
  const store = new Map<string, string>();
  const users = {
    listActiveUsers: async () => [],
    listPausedUsers: async () => paused,
  } as unknown as UserService;
  const sender = {
    send: async (m: { to: string; body: string; channel: string }) => { sends.push(m); },
  } as unknown as MessageSender;
  const generator = { generate: async () => 'x' } as unknown as MessageGenerator;
  const redis = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => { store.set(k, v); return 'OK'; },
  } as unknown as Redis;
  const scheduler = new Scheduler({
    users, sender, generator, logger, redis,
    ...(opts.minGapHours !== undefined ? { reengageQuietMinGapHours: opts.minGapHours } : {}),
    ...(opts.afterHours !== undefined ? { reengageQuietAfterHours: opts.afterHours } : {}),
  });
  return { scheduler, sends, store };
}

async function tick(scheduler: Scheduler): Promise<void> {
  // @ts-expect-error — private
  await scheduler.tick();
}

describe('Scheduler.reengageQuietOptedOut — opted-out users still get a hello', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // A weekday mid-morning in New York (14:00 UTC ≈ 10:00 EDT) — outside quiet hours.
  const setMidMorning = () => vi.setSystemTime(new Date(Date.UTC(2026, 6, 2, 14, 0, 0)));

  it('sends ONE hello to a paused user silent > 24h', async () => {
    setMidMorning();
    const silent = new Date(Date.now() - 30 * 3_600_000); // 30h ago
    const h = buildHarness([makePausedUser({ last_reply_at: silent })]);
    await tick(h.scheduler);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.to).toBe('+15551230000');
    expect(h.sends[0]!.body).toMatch(/🧡/);
  });

  it('does NOT send if silent less than the threshold', async () => {
    setMidMorning();
    const h = buildHarness([makePausedUser({ last_reply_at: new Date(Date.now() - 5 * 3_600_000) })]);
    await tick(h.scheduler);
    expect(h.sends).toHaveLength(0);
  });

  it('never cold-messages a paused user with no prior reply', async () => {
    setMidMorning();
    const h = buildHarness([makePausedUser({ last_reply_at: null })]);
    await tick(h.scheduler);
    expect(h.sends).toHaveLength(0);
  });

  it('throttles: a second tick within the min-gap does not send again', async () => {
    setMidMorning();
    const silent = new Date(Date.now() - 30 * 3_600_000);
    const h = buildHarness([makePausedUser({ last_reply_at: silent })]);
    await tick(h.scheduler);
    await tick(h.scheduler);
    expect(h.sends).toHaveLength(1); // Redis gate suppresses the repeat
  });

  it('respects quiet hours (no send at 2am local)', async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 2, 6, 0, 0))); // 02:00 EDT
    const h = buildHarness([makePausedUser({ last_reply_at: new Date(Date.now() - 48 * 3_600_000) })]);
    await tick(h.scheduler);
    expect(h.sends).toHaveLength(0);
  });

  it('disabled when min-gap is 0', async () => {
    setMidMorning();
    const h = buildHarness([makePausedUser({ last_reply_at: new Date(Date.now() - 48 * 3_600_000) })], { minGapHours: 0 });
    await tick(h.scheduler);
    expect(h.sends).toHaveLength(0);
  });
});
