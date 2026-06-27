/**
 * Conversational onboarding — collect a user's profile over chat instead of a
 * web form, so it feels like talking to Grace, not filling out a survey.
 *
 * Two modes:
 *   - 'signup'  : a brand-new number. Walks a SHORT ordered sequence of the
 *                 minimum required fields (name → medication → schedule → goals →
 *                 consent), then starts the trial. Stripe still handles the paid
 *                 upgrade later via the existing paywall.
 *   - 'gapfill' : an already-registered user missing a few high-value optional
 *                 fields (goal/current weight). Asks one at a time, no consent /
 *                 trial step. Most optional fields are also captured passively by
 *                 the profile-learning extractor, so gap-fill stays light.
 *
 * Design choices that keep it natural and robust:
 *   - QUESTIONS are LLM-generated (warm, varied, personalized — never the same
 *     wording twice) with deterministic fallbacks so a slow/failed LLM never
 *     stalls the flow.
 *   - ANSWERS are parsed deterministically (reusing profile-extract normalizers)
 *     so a value can never be stored malformed.
 *   - STATE lives in the DB (onboarding_state + onboarding_last_slot), not in
 *     memory, so it survives restarts / cold isolates / load-balanced instances.
 *   - "minimum required first, then optional gradually": signup asks only the
 *     core; everything else is learned over time.
 *
 * Pure helpers (slot sequencing + answer parsing) are exported for unit tests.
 */
import type { LLMProvider } from '@grace/shared';
import type { Logger as PinoLogger } from 'pino';

/** Minimal logger surface — accepts pino's Logger and Fastify's request/base
 *  logger (both expose info/warn) without coupling to the full root-logger type. */
type Logger = Pick<PinoLogger, 'info' | 'warn'>;
import type { GraceUser } from '../user/user.service.js';
import {
  normalizeMedication,
  normalizeFrequency,
  normalizeDay,
  normalizeTime,
} from '../services/profile-extract.js';

export type SlotId =
  | 'first_name'
  | 'medication'
  | 'medication_frequency'
  | 'injection_day'
  | 'medication_time'
  | 'goals'
  | 'consent'
  | 'goal_weight'
  | 'current_weight';

/** Minimal user shape the flow reads/writes — keeps it decoupled + testable. */
type FlowUser = Pick<
  GraceUser,
  | 'phone'
  | 'first_name'
  | 'medication'
  | 'medication_frequency'
  | 'injection_day'
  | 'medication_time'
  | 'goals'
  | 'sms_consent'
  | 'goal_weight'
  | 'current_weight'
  | 'trial_start'
  | 'onboarding_state'
  | 'onboarding_last_slot'
>;

type UserWriter = { update(phone: string, fields: Partial<GraceUser>): Promise<void> };

// ── Slot sequencing ──────────────────────────────────────────────────────────

/** The schedule slot depends on how often they dose: weekly/biweekly users have
 *  an injection DAY; daily users have a dose TIME. */
function scheduleSlot(user: Pick<FlowUser, 'medication_frequency'>): SlotId {
  return user.medication_frequency === 'daily' ? 'medication_time' : 'injection_day';
}

/** The ordered signup sequence given what we currently know (the schedule slot
 *  resolves once frequency is answered). Short on purpose — the minimum to start
 *  a useful trial; the rest is learned over time. */
export function signupSequence(user: Pick<FlowUser, 'medication_frequency'>): SlotId[] {
  return ['first_name', 'medication', 'medication_frequency', scheduleSlot(user), 'goals', 'consent'];
}

/** Next signup slot after `lastSlot` (null → the first slot). Returns null when
 *  the sequence is complete. */
export function nextSignupSlot(user: Pick<FlowUser, 'medication_frequency'>, lastSlot: string | null): SlotId | null {
  const seq = signupSequence(user);
  if (!lastSlot) return seq[0]!;
  const idx = seq.indexOf(lastSlot as SlotId);
  if (idx === -1) return seq[0]!; // unknown/stale slot → restart safely
  return seq[idx + 1] ?? null;
}

/** Gap-fill targets: genuinely-nullable, high-value fields only (no defaulted
 *  columns, so we never nag a user about a value we can't tell is real). */
const GAPFILL_SLOTS: SlotId[] = ['goal_weight', 'current_weight'];

export function nextGapfillSlot(user: Pick<FlowUser, 'goal_weight' | 'current_weight'>): SlotId | null {
  for (const slot of GAPFILL_SLOTS) {
    if (slot === 'goal_weight' && user.goal_weight == null) return slot;
    if (slot === 'current_weight' && user.current_weight == null) return slot;
  }
  return null;
}

// ── Answer parsing ───────────────────────────────────────────────────────────

const SKIP_RE = /\b(skip|later|not now|prefer not|rather not|pass|dunno|don'?t know|no idea|maybe later)\b/i;
/** Optional slots the user may skip; required signup slots must be answered. */
const SKIPPABLE: ReadonlySet<SlotId> = new Set(['first_name', 'goals', 'goal_weight', 'current_weight']);

const YES_RE = /\b(yes|yeah|yep|yup|sure|ok|okay|fine|sounds good|go ahead|please do|absolutely|of course|y)\b/i;
const NO_RE = /\b(no|nope|nah|don'?t|do not|stop|rather not|n)\b/i;

// Onboarding asks specifically for a GLP-1, so the medication slot is parsed
// STRICTLY: require a recognized brand or active ingredient. This rejects junk
// ("idk lol", "skip") that the looser profile-learning normalizer would accept —
// there the LLM gates what counts as a medication, but here it's raw user text.
const KNOWN_MED_RE =
  /\b(ozempic|wegovy|mounjaro|zepbound|saxenda|rybelsus|trulicity|victoza|semaglutide|tirzepatide|liraglutide|dulaglutide|compounded)\b/i;
function parseMedicationStrict(text: string): string | null {
  return KNOWN_MED_RE.test(text) ? normalizeMedication(text) : null;
}

function parseName(text: string): string | null {
  const cleaned = text
    .replace(/\b(hi|hey|hello|it'?s|i'?m|im|my name is|name'?s|this is|call me|its)\b/gi, ' ')
    .replace(/[^a-zA-Z'’\- ]/g, ' ')
    .trim();
  const first = cleaned.split(/\s+/)[0] ?? '';
  if (first.length < 2 || first.length > 40) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function parseGoals(text: string): string[] | null {
  const parts = text
    .split(/,|\band\b|\n|\+|&|\//gi)
    .map((p) => p.trim().toLowerCase().replace(/^(to|i want to|i'?d like to|help me)\s+/i, '').trim())
    .filter((p) => p.length >= 2 && p.length <= 60);
  return parts.length > 0 ? Array.from(new Set(parts)).slice(0, 10) : null;
}

function parseWeight(text: string): number | null {
  const m = text.match(/(\d{2,4}(?:\.\d)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n) || n < 50 || n > 1000) return null;
  return Math.round(n);
}

function parseConsent(text: string): boolean | null {
  if (NO_RE.test(text) && !YES_RE.test(text)) return false;
  if (YES_RE.test(text)) return true;
  return null;
}

export interface ParsedAnswer {
  ok: boolean;
  skipped?: boolean;
  /** Validated fields to persist (real `users` columns). */
  fields?: Partial<GraceUser>;
}

/**
 * Parse the user's reply for a given slot into validated `users` fields. Returns
 * ok=false when the reply can't be understood (caller re-asks), or skipped=true
 * for a skippable optional slot the user declined.
 */
export function parseSlotAnswer(slot: SlotId, text: string): ParsedAnswer {
  const t = text.trim();
  if (!t) return { ok: false };
  if (SKIPPABLE.has(slot) && SKIP_RE.test(t)) return { ok: true, skipped: true };

  switch (slot) {
    case 'first_name': {
      const name = parseName(t);
      return name ? { ok: true, fields: { first_name: name } } : { ok: false };
    }
    case 'medication': {
      const med = parseMedicationStrict(t);
      return med ? { ok: true, fields: { medication: med } } : { ok: false };
    }
    case 'medication_frequency': {
      const freq = normalizeFrequency(t);
      return freq ? { ok: true, fields: { medication_frequency: freq } } : { ok: false };
    }
    case 'injection_day': {
      const day = normalizeDay(t);
      return day ? { ok: true, fields: { injection_day: day } } : { ok: false };
    }
    case 'medication_time': {
      const time = normalizeTime(t);
      return time ? { ok: true, fields: { medication_time: time } } : { ok: false };
    }
    case 'goals': {
      const goals = parseGoals(t);
      return goals ? { ok: true, fields: { goals } } : { ok: false };
    }
    case 'consent': {
      const c = parseConsent(t);
      return c == null ? { ok: false } : { ok: true, fields: { sms_consent: c } };
    }
    case 'goal_weight': {
      const w = parseWeight(t);
      return w ? { ok: true, fields: { goal_weight: w } } : { ok: false };
    }
    case 'current_weight': {
      const w = parseWeight(t);
      return w ? { ok: true, fields: { current_weight: w } } : { ok: false };
    }
    default:
      return { ok: false };
  }
}

// ── Question generation (LLM-phrased, varied; deterministic fallback) ─────────

const SLOT_BRIEF: Record<SlotId, string> = {
  first_name: 'their first name (so Grace can address them personally)',
  medication: 'which GLP-1 medication they take (e.g. Ozempic, Wegovy, Mounjaro, Zepbound)',
  medication_frequency: 'how often they take it — weekly or daily',
  injection_day: 'which day of the week they take their weekly shot',
  medication_time: 'what time of day they take their daily dose',
  goals: 'what they most want help with on GLP-1 (protein, hydration, side effects, weight, habits)',
  consent: 'a yes/no OK to text them daily check-ins',
  goal_weight: 'their goal weight, if they have one in mind (it is optional)',
  current_weight: 'their current weight, if they are comfortable sharing (it is optional)',
};

function fallbackQuestion(slot: SlotId, name: string | null, reask: boolean): string {
  const hi = name ? `${name}, ` : '';
  const variants: Record<SlotId, string[]> = {
    first_name: ["Hey, I'm Grace 🧡 What should I call you?", "Hi, I'm Grace! What's your name?"],
    medication: [`${hi}which GLP-1 are you on — Ozempic, Wegovy, Mounjaro, Zepbound, something else?`, `${hi}what medication are you taking?`],
    medication_frequency: [`Got it. Do you take it weekly or daily?`, `And is that a weekly shot or a daily dose?`],
    injection_day: [`Which day do you usually do your shot?`, `What day of the week is your injection?`],
    medication_time: [`What time of day do you usually take it?`, `When do you take your daily dose — morning, evening?`],
    goals: [`What would you most like my help with — protein, hydration, side effects, staying on track?`, `What matters most to you right now on this journey?`],
    consent: [`Is it ok if I check in with you by text now and then? (yes/no)`, `Want me to text you little check-ins? Just reply yes or no.`],
    goal_weight: [`Do you have a goal weight in mind? (totally optional)`, `Any goal weight you're working toward? You can skip this.`],
    current_weight: [`If you're comfortable, what's your current weight? (optional)`, `Mind sharing your current weight? Feel free to skip.`],
  };
  const opts = variants[slot];
  const base = opts[reask ? Math.min(1, opts.length - 1) : Math.floor(Math.random() * opts.length)]!;
  return reask ? `No worries — ${base}` : base;
}

/**
 * Build a warm, varied, personalized question for a slot. Uses the LLM when
 * available (so it's never the same wording twice and adapts to the user), and
 * falls back to a short rotating template otherwise. Always returns quickly.
 */
export async function generateQuestion(
  slot: SlotId,
  user: Pick<FlowUser, 'first_name'>,
  llm: LLMProvider | undefined,
  opts: { reask?: boolean; logger?: Logger } = {},
): Promise<string> {
  const reask = !!opts.reask;
  if (!llm) return fallbackQuestion(slot, user.first_name ?? null, reask);
  try {
    const system = `You are Grace, a warm, casual GLP-1 text companion onboarding a new user one quick question at a time — like a friend texting, never a form.
Write ONE short question (max ~140 chars) to learn ${SLOT_BRIEF[slot]}.
Rules: warm and natural, vary the wording, contractions ok, ${user.first_name ? `use their name "${user.first_name}" naturally` : 'no name yet'}, at most one tiny emoji, no lists, no preamble, plain text only — output just the question.${reask ? ' The user\'s last answer was unclear, so gently re-ask and make it a touch more concrete.' : ''}`;
    const resp = await Promise.race([
      llm.generate({ messages: [{ role: 'system', content: system }, { role: 'user', content: '(generate the question)' }], temperature: 0.85, maxOutputTokens: 80, disableThinking: true }),
      new Promise<{ text: string }>((r) => setTimeout(() => r({ text: '' }), 4000)),
    ]);
    const text = (resp.text ?? '').trim().replace(/^["']|["']$/g, '');
    if (text && /[A-Za-z]{3,}/.test(text)) return text.slice(0, 280);
  } catch (err) {
    opts.logger?.warn({ err: err instanceof Error ? err.message : String(err), slot }, 'onboarding.question.llm_failed');
  }
  return fallbackQuestion(slot, user.first_name ?? null, reask);
}

// ── Turn orchestration ───────────────────────────────────────────────────────

export interface OnboardingTurnResult {
  reply: string;
  completed: boolean;
}

/**
 * Run one onboarding turn. Reads onboarding state off `user`, parses the reply
 * into the slot we last asked, persists it, and asks the next slot — or finishes
 * (signup: starts the trial + records consent). Never throws; on internal error
 * it returns a gentle reply so the user is never left hanging.
 */
export async function runOnboardingTurn(params: {
  user: FlowUser;
  text: string;
  mode: 'signup' | 'gapfill';
  users: UserWriter;
  llm?: LLMProvider;
  logger: Logger;
  now?: Date;
}): Promise<OnboardingTurnResult> {
  const { user, text, mode, users, llm, logger } = params;
  const now = params.now ?? new Date();
  // Local working copy so next-slot computation sees just-persisted values.
  let u: FlowUser = { ...user };

  const pickNext = (): SlotId | null =>
    mode === 'signup' ? nextSignupSlot(u, u.onboarding_last_slot ?? null) : nextGapfillSlot(u);

  try {
    const starting = u.onboarding_state !== 'in_progress';

    // First turn — greet (signup) and ask the first slot. We do NOT parse the
    // user's opening message as an answer (it's usually "hi"); volunteered facts
    // are still captured passively by the profile-learning extractor.
    if (starting) {
      const firstSlot = mode === 'signup' ? nextSignupSlot(u, null) : nextGapfillSlot(u);
      if (!firstSlot) {
        // Nothing to collect (gap-fill with no gaps) — mark done, stay silent.
        await users.update(u.phone, { onboarding_state: 'complete' } as Partial<GraceUser>);
        return { reply: '', completed: true };
      }
      await users.update(u.phone, {
        onboarding_state: 'in_progress',
        onboarding_last_slot: firstSlot,
        onboarding_started_at: now,
      } as Partial<GraceUser>);
      const q = await generateQuestion(firstSlot, u, llm, { logger });
      return { reply: q, completed: false };
    }

    // Continuing — parse the reply into the slot we last asked.
    const slot = (u.onboarding_last_slot as SlotId | null) ?? pickNext();
    if (!slot) {
      await users.update(u.phone, { onboarding_state: 'complete', onboarding_last_slot: null } as Partial<GraceUser>);
      return { reply: '', completed: true };
    }

    const parsed = parseSlotAnswer(slot, text);
    if (!parsed.ok) {
      // Unclear → re-ask the SAME slot (no advance, nothing persisted).
      const q = await generateQuestion(slot, u, llm, { reask: true, logger });
      return { reply: q, completed: false };
    }

    if (parsed.fields && !parsed.skipped) {
      await users.update(u.phone, parsed.fields);
      u = { ...u, ...parsed.fields } as FlowUser;
    }

    // Advance.
    u = { ...u, onboarding_last_slot: slot };
    const next = pickNext();

    if (!next) {
      // Complete.
      if (mode === 'signup') {
        const finish: Partial<GraceUser> = { onboarding_state: 'complete', onboarding_last_slot: null };
        if (!u.trial_start) finish.trial_start = now; // start the trial via SMS signup
        await users.update(u.phone, finish);
        logger.info({ phone: u.phone, mode }, 'onboarding.completed');
        const name = u.first_name ? `${u.first_name}, ` : '';
        return {
          reply: `You're all set ${name}🧡 I'm here whenever you need me — log a meal, ask a question, or just check in. Talk soon.`,
          completed: true,
        };
      }
      await users.update(u.phone, { onboarding_state: 'complete', onboarding_last_slot: null } as Partial<GraceUser>);
      logger.info({ phone: u.phone, mode }, 'onboarding.completed');
      return { reply: `Got it — thanks for sharing that 🧡`, completed: true };
    }

    await users.update(u.phone, { onboarding_last_slot: next } as Partial<GraceUser>);
    const q = await generateQuestion(next, u, llm, { logger });
    return { reply: q, completed: false };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), phone: user.phone }, 'onboarding.turn.error');
    return { reply: `Sorry, I got a bit tangled there — could you say that once more?`, completed: false };
  }
}
