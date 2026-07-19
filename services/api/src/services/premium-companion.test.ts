import { describe, expect, it } from 'vitest';
import { buildPremiumCompanion, premiumAccess, type PremiumCompanionInput } from './premium-companion.js';

const BASE: PremiumCompanionInput = {
  isPaid: true,
  isPro: false,
  trialStart: null,
  medication: 'Zepbound',
  doseMg: 10,
  injectionDay: 'Monday',
  proteinToday: 55,
  proteinGoal: 100,
  caloriesToday: 900,
  waterTodayOz: 32,
  daysProteinLogged: 5,
  avgProtein: 82,
  weightDeltaLbs: -1.4,
  weeklyInsight: 'Protein consistency improved this week.',
  dislikes: ['cottage cheese'],
  symptoms: [{ symptom: 'nausea', count: 3, typicalTiming: 'one day after injection', topRemedy: 'ginger tea' }],
  now: new Date('2026-07-18T12:00:00Z'),
};

describe('premiumAccess', () => {
  it('prioritizes pro, then paid, then an active trial', () => {
    expect(premiumAccess({ isPro: true, isPaid: true, trialStart: null })).toBe('pro');
    expect(premiumAccess({ isPro: false, isPaid: true, trialStart: null })).toBe('plus');
    expect(premiumAccess({ isPro: false, isPaid: false, trialStart: '2026-07-17T12:00:00Z', now: BASE.now })).toBe('trial');
    expect(premiumAccess({ isPro: false, isPaid: false, trialStart: '2026-07-01T12:00:00Z', now: BASE.now })).toBe('free');
  });
});

describe('buildPremiumCompanion', () => {
  it('returns a locked preview for unpaid users without leaking paid content', () => {
    const out = buildPremiumCompanion({ ...BASE, isPaid: false });
    expect(out.unlocked).toBe(false);
    expect(out.upgradePath).toBe('/upgrade');
    expect(out.weeklyReport).toBeNull();
    expect(out.doctorReport).toBeNull();
    expect(out.preview).toContain('Protein consistency');
  });

  it('builds all paid retention surfaces from grounded user data', () => {
    const out = buildPremiumCompanion(BASE);
    expect(out.unlocked).toBe(true);
    expect(out.weeklyReport?.focus).toContain('45g');
    expect(out.injectionInsight?.body).toContain('ginger tea');
    expect(out.doctorReport).toContain('Zepbound 10 mg');
    expect(JSON.stringify(out.dailyPlan)).not.toMatch(/cottage cheese/i);
  });
});
