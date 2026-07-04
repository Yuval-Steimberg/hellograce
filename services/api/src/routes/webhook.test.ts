import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectUpgradeIntent,
  buildUpgradeUrl,
  buildSignupUrl,
  isAccessAllowed,
  needsRegistration,
  isSettingsKeyword,
  coalesceMessages,
  detectPauseIntent,
  shouldSkipCoalesce,
  acquireInflightSlot,
  pickInjectionDoneAck,
  buildUpgradePitch,
  GRACE_MONTHLY_PRICE,
} from './webhook.js';

describe('buildUpgradePitch — Tomo-style in-chat payment pitch', () => {
  it('states the price, the 3-day trial (card + reminder), and the checkout link', () => {
    const p = buildUpgradePitch('Sam', 'https://x/upgrade?phone=1');
    expect(p).toMatch(/Sam/);
    expect(p).toContain(GRACE_MONTHLY_PRICE);
    expect(p.toLowerCase()).toMatch(/3-day free trial/);
    expect(p.toLowerCase()).toMatch(/card/);
    expect(p.toLowerCase()).toMatch(/remind you before/);
    expect(p).toContain('https://x/upgrade?phone=1');
  });
  it('works without a name', () => {
    const p = buildUpgradePitch(null, 'https://x/u');
    expect(p).toMatch(/here's the deal/i);
    expect(p).toContain('https://x/u');
  });
});

// Minimal in-memory Redis mock for coalesceMessages tests.
function makeMockRedis() {
  const lists: Record<string, string[]> = {};
  const locks: Record<string, string | null> = {};

  return {
    async rpush(key: string, val: string) {
      lists[key] = [...(lists[key] ?? []), val];
      return lists[key].length;
    },
    async expire() { return 1; },
    async set(key: string, _val: string, _ex: string, _ttl: number, nx: string) {
      if (nx === 'NX' && locks[key] != null) return null;
      locks[key] = '1';
      return 'OK';
    },
    async lrange(key: string, _start: number, _end: number) { return lists[key] ?? []; },
    async del(key: string) { delete lists[key]; delete locks[key]; return 1; },
  };
}

describe('coalesceMessages', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('first caller acquires lock and returns merged text after coalesce window', async () => {
    const redis = makeMockRedis() as never;
    const promise = coalesceMessages(redis, '+15550000001', 'Will i go bold?');
    await vi.advanceTimersByTimeAsync(3500);
    expect(await promise).toBe('Will i go bold?');
  });

  it('second caller within the window returns null (absorbed)', async () => {
    const redis = makeMockRedis() as never;
    const first = coalesceMessages(redis, '+15550000002', 'Will i go bold?');
    // Second message arrives immediately — lock already held
    const second = coalesceMessages(redis, '+15550000002', 'Bald');
    await vi.advanceTimersByTimeAsync(3500);
    expect(await second).toBeNull();
    expect(await first).toBe('Will i go bold? Bald');
  });

  it('produces single space-joined string from multiple rapid messages', async () => {
    const redis = makeMockRedis() as never;
    const first = coalesceMessages(redis, '+15550000003', 'actually');
    const second = coalesceMessages(redis, '+15550000003', 'never mind');
    const third = coalesceMessages(redis, '+15550000003', 'tell me about nausea');
    await vi.advanceTimersByTimeAsync(3500);
    expect(await second).toBeNull();
    expect(await third).toBeNull();
    expect(await first).toBe('actually never mind tell me about nausea');
  });

  it('releases the window lock after draining — a later message opens a NEW window instead of being absorbed-and-lost', async () => {
    // Regression (pre-2026-06-10): the lock was left to its 5s TTL, so a
    // message arriving 2-5s after the first matched a window that had
    // already drained — return null, never processed, silently dropped.
    const redis = makeMockRedis() as never;
    const first = coalesceMessages(redis, '+15550000004', 'first message');
    await vi.advanceTimersByTimeAsync(2100);
    expect(await first).toBe('first message');

    // 3s after the first message (inside the old 5s lock TTL) — must NOT be absorbed.
    const late = coalesceMessages(redis, '+15550000004', 'late follow-up');
    await vi.advanceTimersByTimeAsync(2100);
    expect(await late).toBe('late follow-up');
  });
});

describe('acquireInflightSlot', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('acquires immediately when no turn is in flight', async () => {
    const redis = makeMockRedis() as never;
    const events: string[] = [];
    const result = await acquireInflightSlot(redis, 'inflight:+15550000010', (e) => events.push(e));
    expect(result).toBe('acquired');
    expect(events).toEqual([]);
  });

  it('WAITS for a held lock and acquires once released — the message is not dropped', async () => {
    // Regression (2026-06-04 → 2026-06-10): a message arriving while a turn
    // was processing failed SET NX once and was silently dropped.
    const redis = makeMockRedis();
    const key = 'inflight:+15550000011';
    await redis.set(key, '1', 'EX', 30, 'NX'); // a previous turn holds the lock

    const events: string[] = [];
    const pending = acquireInflightSlot(redis as never, key, (e) => events.push(e));
    await vi.advanceTimersByTimeAsync(2500); // 2 retries while held
    await redis.del(key); // previous turn finishes
    await vi.advanceTimersByTimeAsync(1100); // next retry succeeds

    expect(await pending).toBe('acquired');
    expect(events).toEqual(['waiting']);
  });

  it('returns busy only after exhausting the full retry budget', async () => {
    const redis = makeMockRedis();
    const key = 'inflight:+15550000012';
    await redis.set(key, '1', 'EX', 30, 'NX'); // never released

    const events: string[] = [];
    const pending = acquireInflightSlot(redis as never, key, (e) => events.push(e));
    await vi.advanceTimersByTimeAsync(30_000); // > 28 × 1s budget
    expect(await pending).toBe('busy');
    expect(events).toEqual(['waiting', 'skip']);
  });

  it('fails open (unavailable) when Redis errors', async () => {
    const redis = { set: async () => { throw new Error('ECONNREFUSED'); } } as never;
    const events: string[] = [];
    const result = await acquireInflightSlot(redis, 'inflight:+15550000013', (e) => events.push(e));
    expect(result).toBe('unavailable');
    expect(events).toEqual(['redis_failed']);
  });
});

describe('pickInjectionDoneAck', () => {
  it('returns a deterministic injection-aware ack from the pool', () => {
    const ack = pickInjectionDoneAck('+15550000020');
    expect(ack).toContain('✅');
    expect(ack.toLowerCase()).toMatch(/check in|check on/);
    // Deterministic for the same user on the same day.
    expect(pickInjectionDoneAck('+15550000020')).toBe(ack);
  });
});

describe('detectUpgradeIntent', () => {
  it('detects single-word intents', () => {
    expect(detectUpgradeIntent('upgrade')).toBe(true);
    expect(detectUpgradeIntent('subscribe')).toBe(true);
    expect(detectUpgradeIntent('pricing')).toBe(true);
  });

  it('detects short phrases', () => {
    expect(detectUpgradeIntent('how do I upgrade?')).toBe(true);
    expect(detectUpgradeIntent('go pro')).toBe(true);
    expect(detectUpgradeIntent('grace pro plan')).toBe(true);
    expect(detectUpgradeIntent('manage my subscription')).toBe(true);
    expect(detectUpgradeIntent('how much does this cost')).toBe(true);
  });

  it('ignores long conversational sentences that happen to mention upgrade', () => {
    // 9+ words = conversational, not a subscription request.
    expect(
      detectUpgradeIntent(
        "I'm thinking about whether I want to upgrade my workout routine this fall",
      ),
    ).toBe(false);
  });

  it('ignores unrelated short messages', () => {
    expect(detectUpgradeIntent('hi')).toBe(false);
    expect(detectUpgradeIntent('thanks!')).toBe(false);
    expect(detectUpgradeIntent('feeling tired today')).toBe(false);
  });

  it('does NOT misfire on nutritional or medical "how much" questions', () => {
    // The original bug: "how much protein on tirzepatide?" was incorrectly
    // routed to the upgrade-management handler instead of the AI.
    expect(detectUpgradeIntent('how much protein on tirzepatide?')).toBe(false);
    expect(detectUpgradeIntent('how much protein per day?')).toBe(false);
    expect(detectUpgradeIntent('how much water should I drink')).toBe(false);
    expect(detectUpgradeIntent('how much weight have I lost')).toBe(false);
    expect(detectUpgradeIntent('how much sleep do I need')).toBe(false);
    expect(detectUpgradeIntent('how much fiber is in oats')).toBe(false);
  });

  it('still catches genuine pricing questions', () => {
    expect(detectUpgradeIntent('how much is grace')).toBe(true);
    expect(detectUpgradeIntent('how much does grace cost')).toBe(true);
    expect(detectUpgradeIntent('how much per month')).toBe(true);
    expect(detectUpgradeIntent('how much to upgrade')).toBe(true);
    expect(detectUpgradeIntent("what's the price")).toBe(true);
    expect(detectUpgradeIntent('price of grace')).toBe(true);
  });
});

describe('buildUpgradeUrl', () => {
  it('URL-encodes the phone number with the default web URL', () => {
    expect(buildUpgradeUrl('+15551234567')).toBe(
      'https://grace-admin-silk.vercel.app/upgrade?phone=%2B15551234567',
    );
  });

  it('respects a custom web URL', () => {
    expect(buildUpgradeUrl('+15551234567', 'https://example.com')).toBe(
      'https://example.com/upgrade?phone=%2B15551234567',
    );
  });

  it('trims trailing slash from the web URL', () => {
    expect(buildUpgradeUrl('+15551234567', 'https://example.com/')).toBe(
      'https://example.com/upgrade?phone=%2B15551234567',
    );
  });
});

describe('isSettingsKeyword', () => {
  it('matches bare settings-intent messages', () => {
    for (const t of ['settings', 'SETTINGS', 'Settings', 'preferences', 'my settings', 'update my settings', 'change settings', 'manage preferences', 'profile', 'account']) {
      expect(isSettingsKeyword(t)).toBe(true);
    }
  });
  it('does NOT fire on prose that merely contains the word', () => {
    for (const t of ["what's my wake time", 'my settings are wrong because of the timezone', 'I changed my mind about settings later', 'can you change my injection day']) {
      expect(isSettingsKeyword(t)).toBe(false);
    }
  });
});

describe('buildSignupUrl', () => {
  it('points at the onboarding flow (no phone param needed)', () => {
    expect(buildSignupUrl('https://example.com')).toBe('https://example.com/onboarding');
    expect(buildSignupUrl('https://example.com/')).toBe('https://example.com/onboarding');
  });
});

describe('registration gate (deleted / never-onboarded users)', () => {
  const base = { is_paid: false, is_pro: false, trial_start: null as Date | null };

  it('a recreated/deleted user (no trial_start, not paid, no profile) needs registration', () => {
    expect(needsRegistration(base)).toBe(true);
    // and is therefore NOT granted access (previously this returned true → the bug)
    expect(isAccessAllowed(base)).toBe(false);
  });

  it('an onboarded user with profile data but NO trial_start is NOT locked out', () => {
    // Production 2026-06-13: completed signup but trial_start did not land.
    expect(needsRegistration({ ...base, medication: 'Ozempic' })).toBe(false);
    expect(needsRegistration({ ...base, goals: ['lose weight'] })).toBe(false);
    // A bare row (no medication, empty goals) still needs registration.
    expect(needsRegistration({ ...base, medication: null, goals: [] })).toBe(true);
  });

  it('an onboarded user inside their trial does NOT need registration and has access', () => {
    const u = { is_paid: false, is_pro: false, trial_start: new Date() };
    expect(needsRegistration(u)).toBe(false);
    expect(isAccessAllowed(u)).toBe(true);
  });

  it('an onboarded user with an EXPIRED trial needs no registration but hits the paywall', () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 3_600_000);
    const u = { is_paid: false, is_pro: false, trial_start: fourDaysAgo };
    expect(needsRegistration(u)).toBe(false); // → paywall path, not the signup path
    expect(isAccessAllowed(u)).toBe(false);
  });

  it('a paid/pro user never needs registration and always has access', () => {
    expect(needsRegistration({ is_paid: true, is_pro: false, trial_start: null })).toBe(false);
    expect(isAccessAllowed({ is_paid: true, is_pro: false, trial_start: null })).toBe(true);
    expect(needsRegistration({ is_paid: false, is_pro: true, trial_start: null })).toBe(false);
    expect(isAccessAllowed({ is_paid: false, is_pro: true, trial_start: null })).toBe(true);
  });
});

describe('detectPauseIntent (Phase 1 coverage expansion)', () => {
  it('matches single-word "pause"', () => {
    expect(detectPauseIntent('pause')).toBe(true);
    expect(detectPauseIntent('stop')).toBe(true);
    expect(detectPauseIntent('break')).toBe(true);
  });

  it('matches "stop sending messages"', () => {
    expect(detectPauseIntent('stop sending messages')).toBe(true);
    expect(detectPauseIntent('pause the reminders')).toBe(true);
    expect(detectPauseIntent('stop the check-ins for now')).toBe(true);
  });

  it('matches "I need a break"', () => {
    expect(detectPauseIntent('I need a break')).toBe(true);
    expect(detectPauseIntent('i want a pause')).toBe(true);
  });

  it("matches \"don't text me for a week\"", () => {
    expect(detectPauseIntent("don't text me for a week")).toBe(true);
    expect(detectPauseIntent("don't text me until next week")).toBe(true);
  });

  it('does NOT match conversational mentions of "pause"', () => {
    // Long sentence — pause is being used conversationally, not as a command.
    expect(detectPauseIntent('I want to pause my workouts for a month due to my shoulder')).toBe(false);
    expect(detectPauseIntent("I'm thinking about stopping my Ozempic")).toBe(false);
  });

  it('does NOT match food-log or greeting messages', () => {
    expect(detectPauseIntent('I just ate two eggs')).toBe(false);
    expect(detectPauseIntent('hi grace')).toBe(false);
    expect(detectPauseIntent('how are you')).toBe(false);
  });
});

describe('shouldSkipCoalesce — knowledge / recommendation skip (Phase 16 latency)', () => {
  it('skips coalesce for clear knowledge questions ending with ?', () => {
    expect(shouldSkipCoalesce('What causes hair loss on Ozempic?')).toBe(true);
    expect(shouldSkipCoalesce('How much protein per day?')).toBe(true);
    expect(shouldSkipCoalesce('Can I take ibuprofen with Ozempic?')).toBe(true);
    expect(shouldSkipCoalesce('Is matcha safe with Wegovy?')).toBe(true);
    expect(shouldSkipCoalesce('Does Mounjaro cause hair loss?')).toBe(true);
    expect(shouldSkipCoalesce('Should I eat before my shot?')).toBe(true);
  });

  it('skips coalesce for clear food recommendation questions', () => {
    expect(shouldSkipCoalesce('What should I eat for lunch?')).toBe(true);
    expect(shouldSkipCoalesce('Any snack ideas?')).toBe(true);
    expect(shouldSkipCoalesce('What are some high protein dinners?')).toBe(true);
  });

  it('still requires the question mark on the knowledge path', () => {
    // These don't match the new knowledge regex (no '?') AND don't match the
    // existing greeting / brief-feeling / food-log skip lists, so they
    // correctly fall through to the 2 s coalesce buffer.
    expect(shouldSkipCoalesce('Actually I changed my mind')).toBe(false);
    expect(shouldSkipCoalesce('Wait one sec')).toBe(false);
    expect(shouldSkipCoalesce('Let me check the bottle')).toBe(false);
  });

  it('does NOT skip statements that happen to have a question word but no ?', () => {
    expect(shouldSkipCoalesce('I dont know what to eat')).toBe(false);
    expect(shouldSkipCoalesce('I told the doctor how I felt')).toBe(false);
  });

  it('does NOT skip very long questions (>120 chars) — give them the buffer', () => {
    const long =
      'What causes hair loss on Ozempic and how should I think about protein and resistance training given that I started semaglutide eight weeks ago?';
    expect(long.length).toBeGreaterThan(120);
    expect(shouldSkipCoalesce(long)).toBe(false);
  });

  it('keeps the original greeting / ack / food-log shortcuts working', () => {
    expect(shouldSkipCoalesce('hi')).toBe(true);
    expect(shouldSkipCoalesce('thanks')).toBe(true);
    expect(shouldSkipCoalesce('I ate two eggs')).toBe(true);
  });
});

describe('shouldSkipCoalesce — "I just had …" food logs (2026-06-11 latency fix)', () => {
  it('skips coalesce for the canonical "I just <verb>" food-log phrasings', () => {
    expect(shouldSkipCoalesce('I just had two eggs and toast')).toBe(true);
    expect(shouldSkipCoalesce('I just ate a sandwich')).toBe(true);
    expect(shouldSkipCoalesce('I just drank a smoothie')).toBe(true);
    expect(shouldSkipCoalesce('I just finished lunch')).toBe(true);
    expect(shouldSkipCoalesce('just had eggs')).toBe(true);
    expect(shouldSkipCoalesce('I had two eggs')).toBe(true);
  });

  it('still buffers long compound logs (tail > 28 chars after the verb)', () => {
    expect(
      shouldSkipCoalesce('I just had grilled chicken thighs with brown rice and roasted broccoli'),
    ).toBe(false);
  });
});
