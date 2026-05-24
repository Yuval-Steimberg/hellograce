import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectUpgradeIntent, buildUpgradeUrl, coalesceMessages } from './webhook.js';

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
    async set(key: string, _val: string, nx: string, _ex: string, _ttl: number) {
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

  it('first caller acquires lock and returns merged text after 2s', async () => {
    const redis = makeMockRedis() as never;
    const promise = coalesceMessages(redis, '+15550000001', 'Will i go bold?');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await promise).toBe('Will i go bold?');
  });

  it('second caller within the window returns null (absorbed)', async () => {
    const redis = makeMockRedis() as never;
    const first = coalesceMessages(redis, '+15550000002', 'Will i go bold?');
    // Second message arrives immediately — lock already held
    const second = coalesceMessages(redis, '+15550000002', 'Bald');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await second).toBeNull();
    expect(await first).toBe('Will i go bold? Bald');
  });

  it('produces single space-joined string from multiple rapid messages', async () => {
    const redis = makeMockRedis() as never;
    const first = coalesceMessages(redis, '+15550000003', 'actually');
    const second = coalesceMessages(redis, '+15550000003', 'never mind');
    const third = coalesceMessages(redis, '+15550000003', 'tell me about nausea');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await second).toBeNull();
    expect(await third).toBeNull();
    expect(await first).toBe('actually never mind tell me about nausea');
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
