/**
 * Dashboard link intercept (2026-07-02). When the user asks to SEE their
 * progress — charts, graphs, stats, "my dashboard", "the app" — Grace hands them
 * the link to the web dashboard (the "real app behind the messages"). Kept
 * deterministic so the link is always correct and Grace never denies the app
 * exists. The host is rewritten to the live deployment URL by TwilioSender.
 */

const DASHBOARD_RE = new RegExp(
  [
    // explicit page / app references
    '\\b(dashboard|progress (?:page|dashboard|tracker|report)|my (?:charts?|graphs?|dashboard|progress page|stats page))\\b',
    // "see / show / view my progress|charts|stats|numbers|data|weight trend"
    '\\b(?:see|show|view|open|pull up|check|track|where(?:\'s| is)?)\\b[^?.!]{0,24}\\b(?:my )?(?:progress|charts?|graphs?|stats|numbers|weight trend|data|results)\\b',
    // "link to my progress / dashboard", "the app", "the website with my data"
    '\\blink to (?:my )?(?:progress|dashboard|charts?|data)\\b',
    '\\b(?:web ?)?app\\b',
  ].join('|'),
  'i',
);

// Guard: don't fire when it's clearly a nutrition/logging action, not a request
// to VIEW a page ("track my protein today", "log my progress note").
const NOT_DASHBOARD_RE = /\b(log|add|record|track my (?:protein|calories|food|meal|water))\b/i;

export function detectDashboardRequest(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t || t.length > 140) return false;
  if (NOT_DASHBOARD_RE.test(t)) return false;
  return DASHBOARD_RE.test(t);
}

/** Warm reply with the dashboard link. `webUrl` is the deployment base (host is
 *  rewritten by TwilioSender from graceglp.com when needed). */
export function buildDashboardLinkReply(webUrl?: string): string {
  const base = (webUrl && /^https?:\/\//.test(webUrl) ? webUrl.replace(/\/+$/, '') : 'https://graceglp.com');
  return `Here's your progress dashboard 🤍 Your weight trend, protein, mood, and the side-effect patterns I've learned about your body — all in one place. You can log things there too: ${base}/dashboard`;
}
