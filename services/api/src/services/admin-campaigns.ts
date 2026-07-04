/**
 * Admin group messaging (campaigns).
 *
 * Sends a single admin-authored message to a cohort of users (or an explicit
 * phone list) through the SAME MessageSender the per-user admin send already
 * uses. Safety is built in:
 *   - Opt-out respected: paused (opted out of proactive), blocked, and inactive
 *     accounts are EXCLUDED and recorded as "skipped", never messaged.
 *   - Duplicate prevention: recipients are de-duped, and a UNIQUE(campaign_id,
 *     phone) constraint makes a double-insert a no-op.
 *   - Confirmation required: sendCampaign throws unless confirm === true.
 *   - Hard audience cap: refuses to send to more than MAX_AUDIENCE users.
 *   - Content guard: refuses messages that look like medical/dose advice.
 *   - Full history: every campaign + per-recipient delivery status is persisted,
 *     and each send is also written to the user's conversation (intent
 *     'admin_campaign') + the audit log.
 *
 * All tables are additive (migration 20260704000001). Every DB call is
 * best-effort where a missing table would otherwise break the admin action.
 */
import type { Pool } from 'pg';
import type { LLMProvider } from '@grace/shared';
import type { MessageSender, OutboundMessage } from '../twilio/sender.js';
import type { MemoryService } from '../memory/memory.service.js';
import { cohortRecipients, isValidCohort } from './admin-analytics.js';

export const MAX_AUDIENCE = 5000;
const MESSAGE_MAX = 1500;

export interface CampaignDeps {
  pool: Pool;
  sender?: MessageSender;
  memory?: MemoryService;
}

type Channel = OutboundMessage['channel'];

function normalizeChannel(raw: string | null | undefined): Channel {
  return raw === 'sms' || raw === 'imessage' || raw === 'whatsapp' ? raw : 'whatsapp';
}

// ── Content safety ───────────────────────────────────────────────────────────
// Conservative blocklist: campaigns are supportive/product messages and must
// never carry medical or dosing guidance. Kept tight to avoid false positives.
const UNSAFE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(take|add|increase|decrease|lower|raise|double|split|skip|adjust|change)\b[^.]*\b(dose|dosage|units?|mg|ml|injection|shot|med(ication)?s?)\b/i, why: 'dosing guidance' },
  { re: /\b\d+\s?mg\b/i, why: 'a specific dose amount' },
  { re: /\bstop taking\b/i, why: 'medication-stop guidance' },
  { re: /\b(diagnos|prescrib)\w*/i, why: 'diagnostic/prescribing language' },
  { re: /\b(cure|treat|reverse)\b[^.]*\b(disease|condition|diabetes|cancer)\b/i, why: 'a medical claim' },
];

export function checkCampaignMessage(message: string): { ok: true } | { ok: false; reason: string } {
  const text = message.trim();
  if (text.length === 0) return { ok: false, reason: 'Message is empty.' };
  if (text.length > MESSAGE_MAX) return { ok: false, reason: `Message exceeds ${MESSAGE_MAX} characters.` };
  for (const { re, why } of UNSAFE_PATTERNS) {
    if (re.test(text)) {
      return { ok: false, reason: `Message looks like it contains ${why}. Admin campaigns must stay supportive/product-related — no medical or dosing advice.` };
    }
  }
  return { ok: true };
}

// ── AI message enhancement ───────────────────────────────────────────────────

export type EnhanceTone = 'warm' | 'concise' | 'motivating' | 'friendly';

const TONE_HINT: Record<EnhanceTone, string> = {
  warm: 'warm, caring, and personal',
  concise: 'short, clear, and to the point',
  motivating: 'encouraging and motivating, without pressure',
  friendly: 'casual and friendly, like a supportive friend',
};

/**
 * Rewrite a draft campaign message in Grace's voice — more engaging while staying
 * SAFE. The rewrite is passed back through checkCampaignMessage, so the enhanced
 * text can never introduce medical/dosing content the composer would reject.
 */
export async function enhanceMessage(
  llm: LLMProvider,
  message: string,
  opts: { tone?: EnhanceTone; audienceLabel?: string } = {},
): Promise<{ enhanced: string }> {
  const draft = message.trim();
  if (draft.length === 0) throw new Error('Nothing to enhance — write a draft first.');
  const tone = TONE_HINT[opts.tone ?? 'warm'];
  const audience = opts.audienceLabel ? ` The recipients are: ${opts.audienceLabel}.` : '';

  const prompt = `You are Grace, a warm WhatsApp/SMS companion for people on GLP-1 medications.
Rewrite the admin's draft broadcast message so it is ${tone} and more engaging, in Grace's voice.${audience}

HARD RULES:
- Keep it ONE short paragraph, suitable for a text message (under ~350 characters).
- Supportive and product-related ONLY. NEVER give medical advice, dosing guidance, or a specific dose/mg amount. Never diagnose or prescribe.
- Plain text only — no markdown, no headings, no lists, no quotation marks around the whole message.
- Keep the original intent and any call-to-action. Do not invent facts, numbers, or promises.
- At most one emoji.

Draft:
"""${draft}"""

Return ONLY the rewritten message text.`;

  const res = await llm.generate({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    maxOutputTokens: 300,
    disableThinking: true,
    skipCache: true,
  });

  let out = res.text.trim().replace(/^["']|["']$/g, '').trim();
  if (out.length === 0) throw new Error('The AI returned an empty message. Try again.');
  const check = checkCampaignMessage(out);
  if (!check.ok) {
    throw new Error(`The AI rewrite was rejected by the safety guard (${check.reason}). Keeping your draft — try again or edit manually.`);
  }
  return { enhanced: out };
}

// ── Audience resolution ──────────────────────────────────────────────────────

export interface AudienceMember {
  phone: string;
  channel: Channel;
}
export interface ExcludedMember {
  phone: string;
  reason: 'paused' | 'blocked' | 'inactive';
}
export interface Audience {
  matched: number;
  eligible: AudienceMember[];
  excluded: ExcludedMember[];
}

export interface AudienceSpec {
  cohortKey?: string;
  phones?: string[];
}

export async function resolveAudience(pool: Pool, spec: AudienceSpec): Promise<Audience> {
  let rows: Array<{ phone: string; channel: string | null; paused: boolean; blocked: boolean; active: boolean }>;

  if (spec.phones && spec.phones.length > 0) {
    const uniq = Array.from(new Set(spec.phones.map((p) => p.trim()).filter(Boolean)));
    const res = await pool.query<{ phone: string; channel: string | null; paused: boolean; blocked: boolean; active: boolean }>(
      `SELECT phone, channel, paused, blocked, active FROM users WHERE phone = ANY($1)`,
      [uniq],
    );
    rows = res.rows;
  } else if (spec.cohortKey) {
    if (!isValidCohort(spec.cohortKey)) throw new Error(`Unknown cohort: ${spec.cohortKey}`);
    rows = await cohortRecipients(pool, spec.cohortKey);
  } else {
    throw new Error('Audience requires a cohortKey or a phones list.');
  }

  // Dedupe by phone (defensive; cohort rows are already unique).
  const seen = new Set<string>();
  const eligible: AudienceMember[] = [];
  const excluded: ExcludedMember[] = [];
  for (const r of rows) {
    if (seen.has(r.phone)) continue;
    seen.add(r.phone);
    if (r.blocked) { excluded.push({ phone: r.phone, reason: 'blocked' }); continue; }
    if (r.paused) { excluded.push({ phone: r.phone, reason: 'paused' }); continue; }
    if (r.active === false) { excluded.push({ phone: r.phone, reason: 'inactive' }); continue; }
    eligible.push({ phone: r.phone, channel: normalizeChannel(r.channel) });
  }
  return { matched: seen.size, eligible, excluded };
}

export interface PreviewResult {
  cohort_key: string | null;
  matched: number;
  eligible_count: number;
  excluded_count: number;
  excluded_breakdown: { paused: number; blocked: number; inactive: number };
  sample: string[];
  over_cap: boolean;
  cap: number;
}

export async function previewCampaign(pool: Pool, spec: AudienceSpec): Promise<PreviewResult> {
  const aud = await resolveAudience(pool, spec);
  const breakdown = { paused: 0, blocked: 0, inactive: 0 };
  for (const e of aud.excluded) breakdown[e.reason] += 1;
  return {
    cohort_key: spec.cohortKey ?? null,
    matched: aud.matched,
    eligible_count: aud.eligible.length,
    excluded_count: aud.excluded.length,
    excluded_breakdown: breakdown,
    sample: aud.eligible.slice(0, 50).map((m) => m.phone),
    over_cap: aud.eligible.length > MAX_AUDIENCE,
    cap: MAX_AUDIENCE,
  };
}

// ── Drafts + history ─────────────────────────────────────────────────────────

export interface SaveDraftInput {
  actor: string;
  cohortKey?: string | null;
  cohortLabel?: string | null;
  message: string;
  channel?: string | null;
  note?: string | null;
}

export async function saveDraft(pool: Pool, input: SaveDraftInput): Promise<{ id: number }> {
  const check = checkCampaignMessage(input.message);
  if (!check.ok) throw new Error(check.reason);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO admin_campaigns (actor, cohort_key, cohort_label, message, channel, status, note)
     VALUES ($1, $2, $3, $4, $5, 'draft', $6) RETURNING id`,
    [input.actor, input.cohortKey ?? null, input.cohortLabel ?? null, input.message, input.channel ?? null, input.note ?? null],
  );
  return { id: rows[0]!.id };
}

export interface CampaignSummary {
  id: number;
  actor: string;
  cohort_key: string | null;
  cohort_label: string | null;
  message: string;
  channel: string | null;
  status: string;
  audience_size: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  note: string | null;
  created_at: string;
  sent_at: string | null;
}

export async function listCampaigns(pool: Pool, limit = 50): Promise<CampaignSummary[]> {
  const { rows } = await pool.query<CampaignSummary>(
    `SELECT id, actor, cohort_key, cohort_label, message, channel, status,
            audience_size, sent_count, failed_count, skipped_count, note, created_at, sent_at
     FROM admin_campaigns ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows;
}

export interface CampaignDetail extends CampaignSummary {
  recipients: Array<{ phone: string; status: string; error: string | null; sent_at: string | null }>;
}

export async function getCampaign(pool: Pool, id: number): Promise<CampaignDetail | null> {
  const { rows } = await pool.query<CampaignSummary>(
    `SELECT id, actor, cohort_key, cohort_label, message, channel, status,
            audience_size, sent_count, failed_count, skipped_count, note, created_at, sent_at
     FROM admin_campaigns WHERE id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  const { rows: recips } = await pool.query<{ phone: string; status: string; error: string | null; sent_at: string | null }>(
    `SELECT phone, status, error, sent_at FROM admin_campaign_recipients
     WHERE campaign_id = $1 ORDER BY status, phone LIMIT 1000`,
    [id],
  );
  return { ...rows[0], recipients: recips };
}

// ── Send ─────────────────────────────────────────────────────────────────────

export interface SendInput extends AudienceSpec {
  actor: string;
  cohortLabel?: string | null;
  message: string;
  channel?: string | null;
  note?: string | null;
  confirm: boolean;
  /** When set, send an already-persisted draft campaign instead of creating one. */
  campaignId?: number;
}

export interface SendResult {
  campaign_id: number;
  audience_size: number;
  sent: number;
  failed: number;
  skipped: number;
  status: string;
}

export async function sendCampaign(deps: CampaignDeps, input: SendInput): Promise<SendResult> {
  if (!input.confirm) throw new Error('Confirmation required: pass confirm=true to send a campaign.');
  if (!deps.sender) throw new Error('No message sender configured.');
  const check = checkCampaignMessage(input.message);
  if (!check.ok) throw new Error(check.reason);

  const audience = await resolveAudience(deps.pool, { cohortKey: input.cohortKey, phones: input.phones });
  if (audience.eligible.length === 0) {
    throw new Error('No eligible recipients (everyone matched is opted out, blocked, or inactive).');
  }
  if (audience.eligible.length > MAX_AUDIENCE) {
    throw new Error(`Audience ${audience.eligible.length} exceeds the safety cap of ${MAX_AUDIENCE}. Narrow the cohort.`);
  }

  // Create or reuse the campaign row.
  let campaignId: number;
  if (input.campaignId != null) {
    campaignId = input.campaignId;
    await deps.pool.query(
      `UPDATE admin_campaigns SET status='sending', audience_size=$2, skipped_count=$3 WHERE id=$1`,
      [campaignId, audience.eligible.length, audience.excluded.length],
    );
  } else {
    const { rows } = await deps.pool.query<{ id: number }>(
      `INSERT INTO admin_campaigns (actor, cohort_key, cohort_label, message, channel, status, audience_size, skipped_count, note)
       VALUES ($1,$2,$3,$4,$5,'sending',$6,$7,$8) RETURNING id`,
      [input.actor, input.cohortKey ?? null, input.cohortLabel ?? null, input.message,
       input.channel ?? null, audience.eligible.length, audience.excluded.length, input.note ?? null],
    );
    campaignId = rows[0]!.id;
  }

  // Record excluded recipients as skipped (idempotent).
  for (const ex of audience.excluded) {
    await deps.pool.query(
      `INSERT INTO admin_campaign_recipients (campaign_id, phone, status, error)
       VALUES ($1,$2,'skipped',$3) ON CONFLICT (campaign_id, phone) DO NOTHING`,
      [campaignId, ex.phone, ex.reason],
    ).catch(() => {});
  }

  let sent = 0;
  let failed = 0;
  for (const m of audience.eligible) {
    // Claim the recipient slot first — ON CONFLICT DO NOTHING means a phone
    // already in this campaign (a retry / duplicate) is not messaged again.
    const claim = await deps.pool.query(
      `INSERT INTO admin_campaign_recipients (campaign_id, phone, status)
       VALUES ($1,$2,'pending') ON CONFLICT (campaign_id, phone) DO NOTHING RETURNING id`,
      [campaignId, m.phone],
    ).catch(() => ({ rowCount: 0 }));
    if (!claim.rowCount) continue; // already handled in this campaign

    const channel = input.channel ? normalizeChannel(input.channel) : m.channel;
    try {
      await deps.sender.send({ to: m.phone, channel, body: input.message });
      sent += 1;
      await deps.pool.query(
        `UPDATE admin_campaign_recipients SET status='sent', sent_at=now() WHERE campaign_id=$1 AND phone=$2`,
        [campaignId, m.phone],
      );
      // Mirror into the conversation thread so the send shows in the viewer.
      if (deps.memory) {
        try {
          const conversationId = await deps.memory.ensureConversation(m.phone);
          await deps.memory.appendTurn({
            conversationId,
            userId: m.phone,
            role: 'assistant',
            content: input.message,
            intent: 'admin_campaign',
          });
        } catch { /* conversation logging is best-effort */ }
      }
    } catch (err) {
      failed += 1;
      await deps.pool.query(
        `UPDATE admin_campaign_recipients SET status='failed', error=$3 WHERE campaign_id=$1 AND phone=$2`,
        [campaignId, m.phone, err instanceof Error ? err.message.slice(0, 500) : String(err)],
      );
    }
  }

  const status = failed === 0 ? 'sent' : sent === 0 ? 'failed' : 'sent';
  await deps.pool.query(
    `UPDATE admin_campaigns SET status=$2, sent_count=$3, failed_count=$4, sent_at=now() WHERE id=$1`,
    [campaignId, status, sent, failed],
  );

  return { campaign_id: campaignId, audience_size: audience.eligible.length, sent, failed, skipped: audience.excluded.length, status };
}
