import { describe, it, expect } from 'vitest';
import { detectUpgradeIntent, buildUpgradeUrl } from './webhook.js';

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
});

describe('buildUpgradeUrl', () => {
  it('URL-encodes the phone number', () => {
    expect(buildUpgradeUrl('+15551234567')).toBe(
      'https://graceglp.com/upgrade?phone=%2B15551234567',
    );
  });
});
