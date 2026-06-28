/* End-to-end flow verification: drives the REAL webhook→AI→DB pipeline. */
import { buildHarness } from './harness.js';

const PHONE = '+13055550199';

async function main() {
  process.env.SMS_ONBOARDING_ENABLED = 'true';
  process.env.DIRECT_REPLY_MODE = 'true';
  process.env.PROGRESSIVE_PROFILE_ENABLED = 'true';
  const h = await buildHarness();
  const line = (s: string) => console.log(s);
  const send = async (label: string, text: string) => {
    const r = await h.sendWhatsApp(PHONE, text, { timeoutMs: 20000 });
    line(`\n[USER ${label}] ${text}`);
    line(`[GRACE] ${r?.body ?? '(no reply)'}`);
    return r?.body ?? '';
  };

  await h.wipeUser(PHONE);
  await h.users.ensureUser(PHONE); // bare row → needsRegistration → signup onboarding

  line('========== ONBOARDING ==========');
  await send('first touch', 'Hi grace, I\'m ready to get started');
  await send('name', 'Yuval');
  await send('medication', 'Mounjaro');     // auto-implies weekly
  await send('injection day', 'Sunday');
  await send('wake/sleep', 'I wake at 7am and sleep at 11pm');
  await send('diet', 'I eat everything');
  await send('consent', 'yes');
  await send('extra (in case more slots)', 'yes');

  // Inspect persisted profile
  const { rows } = await h.pool.query(
    `SELECT onboarding_state, first_name, medication, medication_frequency, injection_day, timezone, wake_time, sleep_time, dietary_restriction FROM users WHERE phone=$1`, [PHONE]);
  line('\n[DB PROFILE] ' + JSON.stringify(rows[0]));

  line('\n========== POST-ONBOARDING ==========');
  await send('food', 'What should I eat today?');
  await send('reminder', 'When is my next reminder?');

  // Scenario B: a legacy user with EMPTY diet → food question MUST gather
  line('\n========== LEGACY USER (empty diet) — gather must fire ==========');
  const P2 = '+13055550200';
  await h.wipeUser(P2);
  await h.createUser(P2, { onboarding_state: 'complete', dietary_restriction: null, dietary_pattern: null, food_dislikes: [], wake_time: null, sleep_time: null });
  await (async () => { const r = await h.sendWhatsApp(P2, 'What should I eat today?', { timeoutMs: 20000 }); line(`\n[USER food] What should I eat today?`); line(`[GRACE] ${r?.body}`); })();
  await (async () => { const r = await h.sendWhatsApp(P2, 'When is my next reminder?', { timeoutMs: 20000 }); line(`\n[USER reminder] When is my next reminder?`); line(`[GRACE] ${r?.body}`); })();

  await h.shutdown();
  line('\n========== DONE ==========');
  process.exit(0);
}
main().catch((e) => { console.error('E2E ERROR:', e); process.exit(1); });
