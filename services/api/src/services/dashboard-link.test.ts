import { describe, it, expect } from 'vitest';
import { detectDashboardRequest, buildDashboardLinkReply } from './dashboard-link.js';

describe('detectDashboardRequest', () => {
  it('fires on explicit progress / dashboard / app requests', () => {
    expect(detectDashboardRequest('show me my progress')).toBe(true);
    expect(detectDashboardRequest('can I see my charts?')).toBe(true);
    expect(detectDashboardRequest('open my dashboard')).toBe(true);
    expect(detectDashboardRequest('where can I see my weight trend')).toBe(true);
    expect(detectDashboardRequest('link to my progress')).toBe(true);
    expect(detectDashboardRequest('is there an app?')).toBe(true);
    expect(detectDashboardRequest('view my stats')).toBe(true);
  });

  it('does NOT fire on food logging / tracking actions', () => {
    expect(detectDashboardRequest('log my protein')).toBe(false);
    expect(detectDashboardRequest('track my food today')).toBe(false);
    expect(detectDashboardRequest('add my meal')).toBe(false);
  });

  it('does NOT fire on unrelated messages', () => {
    expect(detectDashboardRequest('I feel nauseous')).toBe(false);
    expect(detectDashboardRequest('what should I eat for dinner')).toBe(false);
    expect(detectDashboardRequest('')).toBe(false);
  });
});

describe('buildDashboardLinkReply', () => {
  it('includes the /dashboard link and defaults to the canonical host', () => {
    const r = buildDashboardLinkReply();
    expect(r).toContain('https://graceglp.com/dashboard');
  });

  it('honors a provided deployment URL', () => {
    expect(buildDashboardLinkReply('https://grace-admin-silk.vercel.app')).toContain('https://grace-admin-silk.vercel.app/dashboard');
  });
});
