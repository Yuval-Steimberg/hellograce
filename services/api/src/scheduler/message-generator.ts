import type { LLMProvider, DbContentRule } from '@grace/shared';
import { GRACE_SYSTEM_PROMPT, checkContent, endsMidWord, trimToLastCompleteSentence } from '@grace/ai-core';
import type { GraceUser } from '../user/user.service.js';
import type { ContentRulesService } from '../services/content-rules.service.js';
import type { MessageTemplatesService } from '../services/message-templates.service.js';
import { inferMedicationType } from '../services/ai.service.js';

const DEFAULT_WEB_URL = 'https://grace-admin-silk.vercel.app';

function buildUpgradeUrl(phone: string, webUrl: string = DEFAULT_WEB_URL): string {
  const base = webUrl.replace(/\/$/, '');
  return `${base}/upgrade?phone=${encodeURIComponent(phone)}`;
}

// ─── Daily variation engine ───────────────────────────────────────────────────
// Deterministic by phone + date so retries within a day get the same message,
// but the selection rotates every day automatically.

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}

function dailySeed(phone: string): number {
  const today = new Date().toISOString().slice(0, 10);
  let h = 0;
  for (const c of `${phone}:${today}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function pick<T>(arr: readonly T[], seed: number, offset = 0): T {
  return arr[(seed + offset) % arr.length]!;
}

// Angles rotate daily — forces Gemini to approach the topic from a different
// direction each day even when the goal/medication context is identical.
const MORNING_ANGLES = [
  'Lead with one tiny specific action they can do in the next 10 minutes.',
  'Quiet acknowledgment — mornings on GLP-1 can be slow and that\'s okay.',
  'Warm and sensory — like a text from a close friend who thought of them first thing.',
  'One micro-insight about how protein timing works on GLP-1 meds.',
  'Give them permission — they don\'t have to be perfect today.',
  'Reference the progress already made — they\'re still here, still doing it.',
  'Keep it playful and light. Something that makes them smile, not nod dutifully.',
  'Anchor it in a feeling — how do they want to feel by tonight? Work backward.',
  'Be brief and punchy — under 10 words, like a good morning text from someone who gets it.',
  'Offer one practical tip that\'s easy to skip if they\'re not in the mood.',
  'Acknowledge the week they\'re in on their GLP-1 journey.',
  'Focus purely on the one habit they care about most given their stated goal.',
] as const;

const MIDDAY_ANGLES = [
  'Pure warmth — no agenda, just "I\'m thinking of you" energy.',
  'Acknowledge the afternoon energy dip is real and GLP-1 can amplify it.',
  'Focus on the next 2 hours, not the whole day.',
  'One quiet permission: it\'s okay if the morning didn\'t go perfectly.',
  'The most casual version possible — like a friend\'s 3-word text.',
  'A soft practical nudge that doesn\'t feel like a checklist.',
  'Curiosity over advice — one gentle observation about how they might be feeling.',
  'Celebrate that they\'re halfway through the day. No ask required.',
] as const;

const EVENING_ANGLES = [
  'Close the day with warmth — not a review, just presence.',
  'Acknowledge the quiet courage of continuing on hard days.',
  'Reference how long they\'ve been on their GLP-1 journey — every week is something.',
  'Make it about tomorrow, not today — soft anticipation.',
  'Pure comfort — like a warm blanket message, nothing more.',
  'Validation that rest counts as progress.',
  'Brief and loving — the text equivalent of a quiet nod.',
  'Invite reflection only if they want it — make it feel optional, not required.',
  'Specific acknowledgment of what\'s genuinely hard about evenings on this med.',
  'Reference their goal and how simply showing up today connects to it.',
] as const;

const BONUS_ANGLES = [
  'A hydration nudge — GLP-1s suppress thirst alongside hunger.',
  'One quick protein idea they haven\'t heard yet. Surprise them.',
  'Permission to rest — movement counts even if it\'s a short walk.',
  'A small GLP-1 fact they probably didn\'t know. Make it interesting, not clinical.',
  'A "you\'re doing this" moment — no tips, just quiet acknowledgment.',
  'One easy meal or snack idea based on their dislikes and medication.',
  'A gentle body-care nudge — hydration, sleep, or stretching.',
  'Something about their specific medication that\'s useful and non-obvious.',
  'A micro-goal for the next hour. Concrete, tiny, achievable.',
  'Acknowledge something specific about their week number on GLP-1.',
] as const;

const BONUS_CATEGORIES = [
  'hydration', 'protein_tip', 'movement', 'self_care',
  'glp1_knowledge', 'meal_idea', 'body_care', 'micro_goal',
  'acknowledgment', 'mindfulness',
] as const;

// Rotating banned openers — by banning 2 different words each day we prevent
// the model from falling back on its 3-4 favourite opening words.
const OPENER_POOL = [
  'Gentle', 'Just', 'Quick', 'Hey', 'Hi', 'Morning', 'Evening',
  'Small', 'Soft', 'Simply', 'Remember', 'Today', 'Tomorrow',
  'Checking', 'Popping', 'Wanted', 'Hope', 'Thinking', 'Sending',
  'Taking', 'Making', 'Keeping', 'Staying', 'Feeling', 'Starting',
] as const;

// ─── TODAY'S FOCUS — rotating check-in topic (Nudge model, 2026-07-08) ─────────
// Grace's morning/midday/evening reminders historically defaulted to protein/food
// every time (GOAL_MODE_MAP → 'protein'), so a user heard about protein far too
// often. Nudge's send-scheduled-checkin rotates a single TODAY'S FOCUS per
// check-in — weighted by the user's onboarding goals but blended with a universal
// set so it stays human and varied — and enforces TOPIC DISCIPLINE: stay on that
// focus, do NOT default to protein/food unless the focus IS nutrition, never
// recite numbers unless the focus is nutrition. This adapts that model. The pick
// is DETERMINISTIC by the daily seed (+ a per-slot offset) so retries within a
// day are stable while morning/midday/evening still differ.

export type FocusKey =
  | 'protein' | 'nutrition' | 'hydration' | 'movement' | 'rest_sleep'
  | 'mindset' | 'self_compassion' | 'non_scale_win' | 'stress_breath'
  | 'sunlight_fresh_air' | 'connection' | 'side_effect_care';

const FOCUS_DESC: Record<FocusKey, string> = {
  protein: 'Protein — a gentle nudge, numbers only if they genuinely help.',
  nutrition: 'Nutrition — gentle, non-tracking. No calorie talk.',
  hydration: 'Hydration — water, electrolytes, sipping between meals.',
  movement: 'Movement — a walk, a stretch, light strength. Not exercise pressure.',
  rest_sleep: 'Rest and sleep — recovery matters as much as effort.',
  mindset: 'Mindset — patience, trusting the process, one day at a time.',
  self_compassion: 'Self-compassion — be kind to yourself today, however the day looks.',
  non_scale_win: 'Non-scale wins — energy, clothes, mood, sleep, strength. Not the number on the scale.',
  stress_breath: 'Stress + nervous system — a slow breath, a pause, a soft reset.',
  sunlight_fresh_air: 'Sunlight or fresh air — five minutes outside, a window, a doorstep.',
  connection: 'Human connection — a text to someone, a hello, not being alone in this.',
  side_effect_care: 'Comfort + side-effect care — ginger, bland food, slow sips, rest.',
};

// Grace's exact onboarding goal labels (GOAL_MODE_MAP keys) → weighted foci.
const GOAL_FOCUS_WEIGHTS: Record<string, Partial<Record<FocusKey, number>>> = {
  'Eating enough protein': { protein: 5, nutrition: 2, mindset: 1 },
  'Protecting my muscle': { protein: 3, movement: 4, rest_sleep: 2 },
  'Hitting my fiber goals': { nutrition: 5, hydration: 2, side_effect_care: 1 },
  'Staying hydrated': { hydration: 6, side_effect_care: 1 },
  'Losing weight': { non_scale_win: 4, movement: 3, mindset: 2, nutrition: 1, self_compassion: 1 },
  'Managing side effects': { side_effect_care: 5, hydration: 2, rest_sleep: 1, nutrition: 1 },
  'Feeling less alone in this': { connection: 5, self_compassion: 3, mindset: 2 },
  'Building better habits': { mindset: 3, movement: 2, self_compassion: 2, stress_breath: 1, sunlight_fresh_air: 1 },
};
// Blended in for everyone so check-ins stay varied even with a single goal.
const UNIVERSAL_FOCUS_WEIGHTS: Partial<Record<FocusKey, number>> = {
  self_compassion: 1, mindset: 1, stress_breath: 1, sunlight_fresh_air: 1, rest_sleep: 1,
};

const SLOT_FOCUS_OFFSET: Record<string, number> = { morning: 0, midday: 7, evening: 13, bonus: 19 };

export function isNutritionFocus(focus: FocusKey): boolean {
  return focus === 'protein' || focus === 'nutrition';
}

/**
 * Deterministic weighted focus for a given slot + day. Weighted by the user's
 * goals plus a universal set; stable on retry (seed = phone+date), varies across
 * slots (offset) so a user's morning and evening foci differ. Pure.
 */
export function pickTodaysFocus(goals: readonly string[], seed: number, slot: string = 'morning'): FocusKey {
  const weights: Record<string, number> = { ...UNIVERSAL_FOCUS_WEIGHTS } as Record<string, number>;
  for (const g of goals) {
    const map = GOAL_FOCUS_WEIGHTS[g];
    if (!map) continue;
    for (const [t, w] of Object.entries(map)) weights[t] = (weights[t] ?? 0) + (w as number);
  }
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (entries.length === 0) return 'self_compassion';
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let cursor = (seed + (SLOT_FOCUS_OFFSET[slot] ?? 0)) % total;
  for (const [t, w] of entries) {
    cursor -= w;
    if (cursor < 0) return t as FocusKey;
  }
  return entries[0]![0] as FocusKey;
}

/** The TOPIC DISCIPLINE block appended to a scheduled reminder's prompt. */
export function buildFocusBlock(focus: FocusKey): string {
  const nutrition = isNutritionFocus(focus);
  const disc = nutrition
    ? 'A gentle protein/nutrition nudge fits today — keep it soft, numbers only if they truly help.'
    : 'Do NOT default to protein, calories, macros, or food tracking today, and do NOT recite protein/calorie numbers — today is not a nutrition day. No "and don\'t forget your protein" tacked on.';
  return `\nTODAY'S FOCUS: ${FOCUS_DESC[focus]}\nTOPIC DISCIPLINE — write ONE standalone reminder about the focus above and nothing else:\n- ${disc}\n- Context shapes the vibe, it is not the subject: never quote or continue the last chat, never ask a follow-up about a past topic.`;
}

// Focus-matched fallback pools (name-free, per the RLHF rule) — shipped only when
// the LLM output fails to sanitize / duplicates / trips a content rule, so the
// degraded message still matches the day's focus instead of always saying protein.
const FOCUS_FALLBACKS: Record<FocusKey, readonly string[]> = {
  protein: [
    `Quick protein nudge — a little goes a long way today 🌿`,
    `If breakfast was light, a protein snack now is a kind move 🌿`,
  ],
  nutrition: [
    `Something nourishing when you can today — no pressure on amounts 🌿`,
    `Appetite low today? Even a few bites of something real counts 🌿`,
  ],
  hydration: [
    `Water reminder — sip between meals, not with them. Easier on a GLP-1 stomach 🌿`,
    `A glass now sets the rest of the day up. That's the whole nudge 🌿`,
  ],
  movement: [
    `A five-minute walk, even around the room, counts today 🌿`,
    `One little stretch right where you are. That's it 🌿`,
  ],
  rest_sleep: [
    `Rest is part of the work, not a reward for finishing it 🤍`,
    `If you're tired, that's information, not weakness. Be gentle tonight 🌙`,
  ],
  mindset: [
    `Slow progress is still progress. You're doing the thing 🌿`,
    `One day at a time — that's the whole strategy 🌿`,
  ],
  self_compassion: [
    `However today's going, you're allowed to be gentle with yourself 🤍`,
    `No perfect days required. Showing up is enough 🤍`,
  ],
  non_scale_win: [
    `Notice one small thing today — easier stairs, a looser waistband, better mood. That counts 🌿`,
    `The scale isn't the whole story. Energy and sleep count too 🌿`,
  ],
  stress_breath: [
    `One slow breath in, longer out. That's the whole reminder 🌿`,
    `Shoulders down, jaw soft. Tiny reset 🤍`,
  ],
  sunlight_fresh_air: [
    `Five minutes by a window or outside if you can — it helps more than it sounds 🌿`,
    `A doorstep moment of fresh air counts today 🌿`,
  ],
  connection: [
    `Text one person today — you don't have to do this alone 🤍`,
    `A quick hello to someone you like. That's the nudge 🤍`,
  ],
  side_effect_care: [
    `If your stomach's off, plain and small is your friend today 🌿`,
    `Ginger tea, slow sips, soft foods. Be gentle with your system 🤍`,
  ],
};

function focusFallback(focus: FocusKey, seed: number): string {
  return pick(FOCUS_FALLBACKS[focus], seed);
}

type MsgType = 'morning' | 'midday' | 'evening' | 'bonus' | 'injection_morning' | 'injection_followup' |
  'injection_dayafter' | 'side_effect_nausea' | 'side_effect_fatigue' | 'side_effect_constipation' |
  'welcome' | 'trial_expiry_reminder' |
  // Stickiness (2026-06-28): a guided first-week journey (day 1–3 after signup)
  // and an escalating win-back ladder for users who've gone quiet.
  'journey' | 'winback';

export interface GenerateOpts {
  extra?: string;
  isWednesday?: boolean;  // forces mood check regardless of goals
  lowMoodMode?: boolean;  // evening → encouragement over reflection
  /** REAL yesterday food data (morning reminders) — from getDailyProteinHistory. */
  yesterdayFood?: { protein_g: number; calories: number; itemCount: number; proteinGoal: number | null };
  /** REAL same-day food data (evening reminders) — from getTodaysFoodSummary. */
  todayFood?: { protein_g: number; calories: number; itemCount: number; proteinGoal: number | null };
  /** Texts of the last few reminders sent to this user — the new message must
   *  not repeat any of them. Also used for a post-generation duplicate check. */
  recentMessages?: string[];
  /** The user's own recent messages (most recent last) — lets the reminder
   *  reference a topic they actually raised. Woven in only if clearly relevant;
   *  never invented. */
  conversationContext?: string[];
  /** First-week guided journey: which day (1, 2, or 3) after signup this is. */
  journeyDay?: number;
  /** Win-back ladder stage: 1 (≈1 day quiet), 2 (≈3 days), 3 (≈7+ days). */
  winbackStage?: number;
  /** Personal injection-day heads-up derived from the user's own symptom history
   *  (symptom-intelligence) — a directive block woven into the injection_morning
   *  reminder so Grace can gently pre-empt a recurring side effect + what helped
   *  before. Empty/absent when there's no confident pattern. */
  symptomHeadsUp?: string;
  /** GROUNDED injection number for the injection_morning reminder (the "#N" in a
   *  Nudge-style message), derived from glp1_start_date + cadence — never invented.
   *  Absent when we can't compute it (no start date). */
  injectionNumber?: number;
}

/**
 * The grounded injection number ("this is your #N shot") derived from the GLP-1
 * start date + cadence — accurate for existing users too (unlike injection_count,
 * which was never maintained). Weekly → weeks since start + 1; biweekly → half
 * that. Returns null when there's no usable start date or the result is
 * implausible (a mis-entered start date), so we never show a wrong number.
 */
export function injectionNumberFromStart(
  startDate: Date | string | null | undefined,
  frequency: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!startDate) return null;
  const start = new Date(startDate).getTime();
  if (Number.isNaN(start)) return null;
  const weeks = Math.floor((now.getTime() - start) / (7 * 24 * 3_600_000));
  if (weeks < 0) return null;
  const interval = (frequency ?? '').toLowerCase() === 'biweekly' ? 2 : 1;
  const n = Math.floor(weeks / interval) + 1;
  return n >= 1 && n <= 260 ? n : null; // cap ~5 years — beyond that a bad start date
}

// ─── Morning "yesterday bridge" ──────────────────────────────────────────────
// A morning reminder feels personal when it gently continues yesterday's thread
// instead of reading like a generic daily notification. We derive a single
// SUGGESTED ANGLE deterministically from data the scheduler already gathered
// (yesterday's food totals + the user's own recent messages + an active
// side-effect flow) — no extra DB calls, no raw-history dump. The generator
// weaves it in naturally (and only if it fits); it never recites or invents.

const SYMPTOM_RE =
  /\b(nause\w*|sick to my stomach|throw\s?up|threw up|vomit\w*|constipat\w*|can'?t poop|diarrh\w*|reflux|heartburn|headache|migraine|dizz\w*|fatigue|exhaust\w*|so tired|no energy|bloat\w*|cramp\w*|stomach (?:hurt|ache|pain|issues)|gassy)\b/i;

const NEGATIVE_EMOTION_RE =
  /\b(frustrat\w*|struggl\w*|hard time|so hard|overwhelm\w*|defeat\w*|giving up|give up|discourag\w*|hate this|stress\w*|anxious|anxiety|\bsad\b|feeling down|\bdown\b|cried|crying|rough day|tough day|not working|hopeless)\b/i;

const POSITIVE_EMOTION_RE =
  /\b(great day|good day|feel\w* (?:good|great|amazing|better)|proud|happy|excited|went well|on track|crushed it|so good|going well)\b/i;

/** First symptom phrase found in the user's recent messages, normalized for the
 *  prompt ("nausea", "a rough stomach", …). Returns null when none. */
function findSymptomMention(messages: string[]): string | null {
  for (const m of messages) {
    const hit = m.match(SYMPTOM_RE);
    if (hit) return hit[0].toLowerCase();
  }
  return null;
}

export interface MorningBridge {
  /** The prompt block to append, or '' when nothing from yesterday fits. */
  block: string;
  /** True when a single gentle question fits this morning (e.g. checking on a
   *  symptom). Lets the morning instruction relax its default "no questions". */
  allowQuestion: boolean;
  /** What drove the bridge, so the morning path can decide whether the rotating
   *  TODAY'S FOCUS should take over. 'protein' (yesterday came up short) is
   *  suppressed on a non-nutrition focus day so Grace stops over-indexing on
   *  protein; 'symptom'/'emotion' (human continuity) always win. */
  kind: 'symptom' | 'emotion' | 'protein' | 'positive' | 'quiet' | 'none';
}

/**
 * Build the morning "yesterday bridge" directive. Priority (most human-first):
 * lingering symptom → emotional struggle → missed protein → good day → quiet
 * day. Safety: a symptom angle always carries a soft "check with your doctor if
 * it's still rough" so a real issue is never brushed off. Pure + deterministic.
 */
export function deriveMorningBridge(
  user: Pick<GraceUser, 'side_effect_flow'>,
  opts?: Pick<GenerateOpts, 'yesterdayFood' | 'conversationContext'>,
): MorningBridge {
  const convo = (opts?.conversationContext ?? []).filter((m) => m && m.trim().length > 0);
  const symptom = findSymptomMention(convo) ?? (user.side_effect_flow ? user.side_effect_flow.replace(/_/g, ' ') : null);
  const emotionalRough = convo.some((m) => NEGATIVE_EMOTION_RE.test(m)) && !convo.some((m) => POSITIVE_EMOTION_RE.test(m));
  const emotionalPositive = convo.some((m) => POSITIVE_EMOTION_RE.test(m));
  const y = opts?.yesterdayFood;

  let angle = '';
  let allowQuestion = false;
  let kind: MorningBridge['kind'] = 'none';
  const extra: string[] = [];

  if (symptom) {
    angle = `Yesterday they had a rough time with ${symptom}. Open by gently checking how that's feeling this morning, and keep today's food simple and easy on the stomach. If it sounds like it's still lingering or getting worse, softly suggest they check with their doctor.`;
    allowQuestion = true;
    kind = 'symptom';
  } else if (emotionalRough) {
    angle = `Yesterday felt heavy or frustrating for them. Lead with a clean-slate, no-pressure reset — today's a fresh start, no need to be perfect, just here when they need you.`;
    kind = 'emotion';
  } else if (y && y.itemCount > 0 && y.proteinGoal && y.protein_g < y.proteinGoal) {
    angle = `Yesterday came up a little short on protein. Nudge ONE easy protein-first meal to make today smoother — encouraging, never scolding, and don't quote the numbers.`;
    kind = 'protein';
  } else if (emotionalPositive) {
    angle = `Yesterday looked solid for them. Acknowledge it warmly and invite building on it today — keep it light and simple.`;
    kind = 'emotion';
  } else if (y && y.proteinGoal && y.protein_g >= y.proteinGoal && y.itemCount > 0) {
    angle = `Yesterday looked solid for them. Acknowledge it warmly and invite building on it today — keep it light and simple.`;
    kind = 'positive';
  } else if (y && y.itemCount === 0) {
    angle = `Yesterday was quiet — nothing logged. Warm fresh-start hello, zero pressure, and an easy open door to share what they eat today.`;
    kind = 'quiet';
  }

  if (!angle) return { block: '', allowQuestion: false, kind: 'none' };

  let block = `\nYESTERDAY BRIDGE — make this morning feel like a natural continuation of yesterday, the way a real friend would pick the thread back up (NOT a report, NOT a recap):\n- ${angle}`;
  if (extra.length > 0) block += `\n- ${extra.join('\n- ')}`;
  block += `\n- Weave it in naturally and ONLY if it fits. NEVER say "based on our conversation yesterday" / "yesterday you logged" / recite totals. Don't force it — if it feels off, just send a warm, plain good-morning. Vary the shape from previous mornings. Keep it to one short, warm message.`;

  return { block, allowQuestion, kind };
}

/**
 * Anticipation hook — on roughly 1 in 3 days (deterministic by the daily seed),
 * tell the generator to end with a small forward teaser so the NEXT proactive
 * message has a reason to be opened. Empty string on the other days so it never
 * feels formulaic. Never promises anything medical.
 */
export function anticipationDirective(seed: number): string {
  if (seed % 3 !== 0) return '';
  return ` ANTICIPATION: end with ONE short, warm teaser that gives them something to look forward to next time (e.g. "tomorrow I'll show you a little trick for X" or "remind me to tell you about Y"). Make it specific and genuine, never clickbait, and never promise anything medical or guaranteed.`;
}

const FALLBACKS: Record<MsgType, (user: GraceUser, opts?: GenerateOpts) => string> = {
  morning: (u, opts) => {
    if (opts?.isWednesday) {
      const pool = [
        `Mid-week check — how are you actually feeling today? No wrong answers 🌿`,
        `Halfway through the week. How are you holding up — honestly?`,
        `Wednesday already. Softer question today: what's actually going on with you?`,
        `Mid-week. No agenda — just genuinely curious how you're doing 🌿`,
      ];
      return pick(pool, dailySeed(u.phone));
    }
    // Focus-matched fallback so the degraded morning matches the day's rotating
    // focus instead of always leading with protein.
    const seed = dailySeed(u.phone);
    return focusFallback(pickTodaysFocus(u.goals, seed, 'morning'), seed);
  },
  midday: (u) => {
    const seed = dailySeed(u.phone);
    return focusFallback(pickTodaysFocus(u.goals, seed, 'midday'), seed);
  },
  evening: (u, opts) => {
    const seed = dailySeed(u.phone);
    if (opts?.lowMoodMode) {
      return pick([
        `Thinking of you tonight. You're doing something genuinely hard, and it counts even on the quiet days 🤍`,
        `Hard days still count. You're still here. That's something 🤍`,
        `Whatever today was — you got through it. Rest well 🌙`,
        `Some days the win is just making it to evening. Tonight counts 🤍`,
      ], seed);
    }
    return focusFallback(pickTodaysFocus(u.goals, seed, 'evening'), seed);
  },
  injection_morning: (u) => {
    const med = u.medication ?? 'your medication';
    const seed = dailySeed(u.phone);
    const n = injectionNumberFromStart(u.glp1_start_date, u.medication_frequency);
    const num = n ? ` Injection #${n}.` : '';
    return pick([
      `${med} day 💉${num} Rotate to a different spot than last time and take your time. Keep ginger tea, plain crackers, and electrolytes handy just in case. Reply "done" when you're set.`,
      `Injection day 💉${num} Rotate your site, breathe through it, and keep ginger tea + crackers nearby just in case. Just reply "done" when it's done.`,
      `${med} day 💉${num} Different spot than last time, go slow. Electrolytes and ginger tea ready if you need them. "Done" when you're ready.`,
      `Injection day.${num} Take your time — rotate the spot, breathe. Ginger tea, plain crackers, electrolytes on hand just in case. Reply "done" after 💉`,
    ], seed);
  },
  injection_followup: (u) => {
    return pick([
      `Checking in since your shot — hope you're feeling okay. I'm here if anything's up 🤍`,
      `Checking in after your injection. How's your body feeling?`,
      `Post-shot check-in. Nausea, fatigue, or anything off? Or all good so far?`,
      `Just thinking about you after your injection today. How are you doing?`,
    ], dailySeed(u.phone));
  },
  injection_dayafter: (u) => {
    return pick([
      `Day after your shot — be gentle with yourself today 🤍`,
      `Morning after injection day. If you're feeling the effects, that's normal. Rest if you need to 🤍`,
      `Post-injection morning. Your body's adjusting — take it slow today 🌿`,
      `The day after can feel different. Be soft with yourself today 🤍`,
    ], dailySeed(u.phone));
  },
  side_effect_nausea: (u) => {
    return pick([
      `Hope the nausea's easing. Ginger tea and tiny sips help a lot of people 🤍`,
      `Checking in softly — nausea on ${u.medication ?? 'GLP-1'} is real and it passes. Tiny sips, cold water, rest 🤍`,
      `How's the nausea now? Ginger, cold water, and horizontal help most. Here if you need to talk through it 🤍`,
    ], dailySeed(u.phone));
  },
  side_effect_fatigue: (u) => {
    return pick([
      `Fatigue is real on this med. Rest if you can — a bit of protein + water often helps. I'm here 🤍`,
      `The tiredness on ${u.medication ?? 'GLP-1'} is legitimate. Rest isn't giving up. Protein + water when you can 🤍`,
      `Checking in on the fatigue. Your body's working hard adjusting. Rest as much as you need 🤍`,
    ], dailySeed(u.phone));
  },
  side_effect_constipation: (u) => {
    return pick([
      `Soft check-in. Water, fiber, and a short walk are the usual gentle helpers if things are still slow 🌿`,
      `How are things moving? Water + fiber + gentle movement is the standard trio that helps most people 🌿`,
      `Checking in on that side effect. Magnesium, water, and walking help a lot — let me know if you want more specifics 🌿`,
    ], dailySeed(u.phone));
  },
  welcome: (u) => {
    const name = u.first_name ?? 'there';
    // Deterministic, compliance-correct welcome (2026-06-14). NOT LLM-generated:
    // the STOP/HELP + "Msg & data rates may apply" footer is an A2P requirement
    // and must ship verbatim — an LLM would paraphrase or drop it. generate()
    // short-circuits 'welcome' to this template so the exact wording always ships.
    return `Hi ${name}, it's Grace, your new GLP-1 sidekick. I'll check in daily with meal ideas, protein tips, and encouragement. Text me what you ate (or snap a pic) and I'll log it. Want to see your progress anytime? Just text me "dashboard" and I'll send your private link — weight, protein, mood, and the side-effect patterns I learn about your body, all in one place. Ask me anything, anytime. Save this number so you never miss a check-in. Reply STOP to cancel, HELP for help. Msg & data rates may apply.`;
  },
  trial_expiry_reminder: (u) => {
    const upgradeUrl = buildUpgradeUrl(u.phone);
    return `Your Grace trial ends tomorrow 🧡 Head to ${upgradeUrl} anytime to keep your check-ins going — no pressure, whenever you're ready.`;
  },
  journey: (u, opts) => {
    const day = opts?.journeyDay ?? 1;
    const byDay: Record<number, string[]> = {
      1: [
        `Morning! Day one together 🧡 Easiest place to start: next time you eat, just text me what it was and I'll handle the protein math for you.`,
        `Hey! So glad you're here. Let's keep day one simple — text me your next meal (or snap a pic) and I'll log it for you.`,
      ],
      2: [
        `Day two 🧡 Little trick most people don't know: eating your protein FIRST in a meal keeps you full longer. Try it today and tell me how it goes.`,
        `Morning! Quick one for today — front-load your protein at your first meal and see if the afternoon feels easier. I'm curious how it lands.`,
      ],
      3: [
        `Day three! You can send me photos too — snap your plate and I'll break down the protein for you. Way easier than guessing 🧡`,
        `Morning 🧡 Try this today: next time you're not sure about a meal, just send me a pic. I'll do the rest.`,
      ],
    };
    return pick(byDay[Math.min(3, Math.max(1, day))] ?? byDay[1]!, dailySeed(u.phone));
  },
  winback: (u, opts) => {
    const stage = opts?.winbackStage ?? 1;
    const name = u.first_name ? `${u.first_name}, ` : '';
    const byStage: Record<number, string[]> = {
      1: [
        `Hey ${name}thinking of you today 🧡 No pressure at all — just text me what you ate whenever and I'll pick it right back up.`,
        `Morning! Door's always open here. Whenever you're ready, tell me how it's going and we'll roll from there 🧡`,
      ],
      2: [
        `Hey ${name}it's been a few days and I still got you 🧡 We can start fresh anytime — even one quick meal text gets us going again.`,
        `No guilt, promise — life gets busy. I'm right here whenever you want to jump back in, even just to say hi 🧡`,
      ],
      3: [
        `Hey ${name}I've missed our check-ins 🧡 Whenever you're ready to pick things back up, I'm here — no catching up required, we just start from today.`,
        `Still in your corner, whenever you want me. One text and we're back at it, no pressure at all 🧡`,
      ],
    };
    return pick(byStage[Math.min(3, Math.max(1, stage))] ?? byStage[1]!, dailySeed(u.phone));
  },
  bonus: (u) => {
    const seed = dailySeed(u.phone);
    const pool = [
      'Water check — GLP-1s quiet your thirst alongside hunger. One glass right now helps more than you think.',
      `Quick protein thought: ${u.protein_goal_grams ?? 80}g is your daily target. A Greek yogurt or handful of nuts gets you closer without effort.`,
      'Movement doesn\'t have to be a workout. A 10-minute walk after a meal helps digestion and steadies blood sugar.',
      'Rest is part of the process. If your body says slow down today, listen.',
      'GLP-1 tip: eating protein first in a meal helps absorption and keeps you full longer.',
      'Hydration affects everything — energy, skin, digestion, mood. One extra glass today.',
      `Reminder that week by week on ${u.medication ?? 'your medication'}, your body is adjusting. Patience is progress.`,
      'Small win for the next hour: one protein-rich snack or a full glass of water.',
      'Your body is doing a lot right now. Give it something nourishing, even if appetite is low.',
      'Muscle protection matters on GLP-1. Every bit of protein and movement counts toward keeping what you\'ve built.',
    ];
    return pick(pool, seed, 5);
  },
};

export class MessageGenerator {
  private activeSystemPrompt: string | undefined;
  private rulesService: ContentRulesService | undefined;
  private templatesService: MessageTemplatesService | undefined;
  private webUrl: string = DEFAULT_WEB_URL;

  constructor(private llm: LLMProvider) {}

  updateRulesService(rs: ContentRulesService): void {
    this.rulesService = rs;
  }

  /**
   * Optional templates service used to substitute the welcome / trial-reminder
   * fallbacks with the admin-editable versions from message_templates table.
   * Falls back to the static FALLBACKS[type] map if not provided or template
   * lookup fails.
   */
  updateTemplatesService(ts: MessageTemplatesService): void {
    this.templatesService = ts;
  }

  /** Set the public web URL used for upgrade + settings links in scheduled messages. */
  updateWebUrl(url: string): void {
    this.webUrl = url;
  }

  /**
   * Update the system prompt used for proactive (scheduled) messages.
   * Called on startup with the DB-active prompt and again whenever the
   * PromptOptimizer auto-activates a new version, so RLHF improvements
   * affect every channel — reactive AND proactive.
   */
  updateSystemPrompt(prompt: string | undefined): void {
    this.activeSystemPrompt = prompt;
  }

  async generate(type: MsgType, user: GraceUser, opts?: GenerateOpts): Promise<string> {
    // For subscription-related messages (welcome, trial reminder) ops can
    // override the canned fallback via the message_templates table. If the
    // template lookup fails for any reason, fall through to the hard-coded
    // FALLBACKS map so the user is never left silent.
    const fallback = await this.resolveFallback(type, user, opts);
    // The welcome is deterministic — it carries the A2P compliance footer
    // (STOP/HELP, "Msg & data rates may apply") which must ship verbatim, so we
    // never route it through the LLM. resolveFallback still lets ops override it
    // via the message_templates 'welcome' row without a deploy.
    if (type === 'welcome') return fallback;
    try {
      const userCtx = this.buildUserCtx(user);
      const prompt = this.buildPrompt(type, user, opts);
      const systemPrompt = this.activeSystemPrompt ?? GRACE_SYSTEM_PROMPT;

      const resp = await this.llm.generate({
        messages: [
          { role: 'system', content: systemPrompt + '\n\n' + userCtx },
          { role: 'user', content: prompt },
        ],
        temperature: 0.85,
        maxOutputTokens: 280,
        model: 'gemini-2.5-flash',
        disableThinking: true,
      });

      // 'welcome' is handled deterministically above and never reaches here,
      // so every message at this point should have the user's name stripped.
      const sanitized = sanitizeProactiveOutput(resp.text, user.first_name);
      if (!sanitized) return fallback;

      // Anti-repetition: never ship a reminder that duplicates one of the
      // last few sent to this user. The prompt already lists them as banned;
      // this is the deterministic backstop. Fallbacks rotate daily by seed,
      // so the fallback itself won't repeat yesterday's fallback.
      if (opts?.recentMessages?.some((prev) => isNearDuplicate(sanitized, prev))) {
        return fallback;
      }

      // Full content check on proactive messages — same coverage as the
      // reactive path. Until this was added, only DB rules ran here while the
      // reactive AIService had a 4-layer checker (banned phrases, dietary
      // violations, food dislikes, medication contradiction). Now both paths
      // share the same final guard. Any block/regen violation falls back to
      // the canned response since proactive messages can't regen with chat
      // history context.
      const rules: DbContentRule[] = this.rulesService
        ? await this.rulesService.getActive('scheduler').catch(() => [])
        : [];
      const cleanDislikes = (user.food_dislikes ?? [])
        .map((d) => d.replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
        .filter(Boolean);
      const violations = checkContent(sanitized, {
        foodDislikes: cleanDislikes,
        medicationType: inferMedicationType(user.medication),
        responseMode: 'text',
        dbRules: rules,
      });
      const actionable = violations.filter(
        (v) => v.severity === 'block' || v.severity === 'regen' || !v.severity,
      );
      if (actionable.length > 0) return fallback;

      return sanitized;
    } catch {
      return fallback;
    }
  }

  /**
   * Pick the right fallback string for the message type. For subscription
   * messages (welcome, trial reminder) we consult the message_templates
   * table so admins can edit them without a deploy. Variable substitution:
   *   {first_name} -> user.first_name (or "there")
   *   {medication} -> user.medication (or "your GLP-1")
   *   {goal}       -> user.goals[0]   (or "general wellness")
   *   {upgrade_url} -> https://graceglp.com/upgrade?phone={phone}
   */
  private async resolveFallback(type: MsgType, user: GraceUser, opts?: GenerateOpts): Promise<string> {
    const staticFallback = FALLBACKS[type](user, opts);
    if (!this.templatesService) return staticFallback;
    const templateKey = type === 'welcome' ? 'welcome'
      : type === 'trial_expiry_reminder' ? 'trial_reminder'
      : null;
    if (!templateKey) return staticFallback;
    try {
      return await this.templatesService.render(
        templateKey,
        {
          first_name: user.first_name ?? 'there',
          medication: user.medication ?? 'your GLP-1',
          goal: user.goals[0] ?? 'general wellness',
          upgrade_url: buildUpgradeUrl(user.phone, this.webUrl),
        },
        staticFallback,
      );
    } catch {
      return staticFallback;
    }
  }

  private buildUserCtx(user: GraceUser): string {
    const lines = [];
    if (user.first_name) lines.push(`Name: ${user.first_name}`);
    if (user.medication) lines.push(`Medication: ${user.medication}`);
    if (user.goals.length > 0) lines.push(`Goals: ${user.goals.join(', ')}`);
    if (user.food_dislikes.length > 0) {
      const clean = user.food_dislikes
        .map((d) => d.replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
        .filter(Boolean);
      lines.push(`Food dislikes (paraphrase naturally — NEVER quote verbatim): ${clean.join(', ')}`);
    }
    if (user.current_weight && user.goal_weight) {
      lines.push(`Weight: ${user.current_weight} lbs (goal: ${user.goal_weight} lbs, gap: ${Math.abs(user.current_weight - user.goal_weight).toFixed(0)} lbs)`);
    }
    if (user.protein_goal_grams) {
      lines.push(`Personal daily protein target: ${user.protein_goal_grams}g — use THIS, not 80g`);
    }
    return lines.length > 0 ? `User context:\n${lines.join('\n')}` : '';
  }

  private buildPrompt(type: MsgType, user: GraceUser, opts?: GenerateOpts): string {
    const cleanDislikes = user.food_dislikes
      .map((d) => d.replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
      .filter(Boolean);
    const dislikes = cleanDislikes.length > 0
      ? `NEVER suggest these foods (paraphrase naturally, don't quote raw text): ${cleanDislikes.join(', ')}.`
      : '';

    // Daily variation — deterministic by user + date so retries stay consistent
    // but each new day gets a fresh angle and different banned openers.
    const seed = dailySeed(user.phone);
    const angleMap: Record<string, readonly string[]> = {
      morning: MORNING_ANGLES, midday: MIDDAY_ANGLES, evening: EVENING_ANGLES, bonus: BONUS_ANGLES,
    };
    const anglePool = angleMap[type] ?? MORNING_ANGLES;
    const todayAngle = pick(anglePool, seed);
    const bannedOpener1 = pick(OPENER_POOL, seed, 0);
    const bannedOpener2 = pick(OPENER_POOL, seed, 3);
    const bannedOpener3 = pick(OPENER_POOL, seed, 7);
    // Anticipation hook — occasionally end with a forward teaser (see helper).
    const hook = anticipationDirective(seed);

    const VARIATION_BLOCK = `TODAY'S VARIATION DIRECTIVE (changes daily — follow exactly):
- Angle: ${todayAngle}
- Banned first word today: "${bannedOpener1}", "${bannedOpener2}", "${bannedOpener3}" — your message MUST NOT start with any of these.
- Every message must feel written for today, not copy-pasted from yesterday. If the same user got a message yesterday, this one must read differently — different structure, different opening word, different rhythm.`;

    const RULES = `RULES — proactive (scheduled) messages, written like a friend who actually knows them:
- This should feel like a warm, personal check-in from someone in their corner — NOT a system notification, a coach, or a generic health app. Casual, human, specific to them.
- It still has to stand on its own and land a little warmth or value (a gentle nudge, a kind observation, one small idea). They didn't ask for it, so make it feel like a thoughtful text, not a task.
- Keep it short: 1 sentence is best, 2 max. Easy to read at a glance. Contractions always.
- Mostly land on a warm statement. A single soft, low-pressure question is fine when it genuinely reads like a friend checking in ("did you have anything else you want me to add?") — but NEVER stack questions, quiz them ("how's X? how's Y?"), or ask for numbers ("rate 1-10", "how many oz").
- Warm, calm, real. No motivational speeches, no hype, no exclamation-point energy unless it truly fits.
- Make it personal: lean on what's actually true for them today (the REAL DATA + recent conversation below) so it never reads like a template. If there's no data, a simple warm note is perfect — NEVER invent food logs, protein numbers, symptoms, goals, or injection details.
- The vibe (✓): "morning — even one protein-first meal early can make the whole day feel easier." / "quick thought: a few sips of water now help more than it sounds, especially if your appetite's been weird lately." / "hope you're noticing the little wins today — more energy, clothes fitting better. the scale's never the whole story." / "thinking of you tonight — no pressure, just glad you're in this."
- NOT this (✗): "Prioritizing protein can help maintain steady energy." (corporate) / "Reminder: please log your meals." (robotic) / "How's your eating? Any cravings? What did you have?" (a quiz, not a friend).
- WRITE AS IF TEXTING THEM DIRECTLY. NEVER address the user by name. NEVER open with "For <name>," / "Dear <name>" / "To <name>" / "Hi <name>" / "Dear user" / "As your assistant" — those read like a mail-merge template, not a text from a friend.
- ZERO TOLERANCE — NEVER start the message with a label or category prefix. ALL of the following are strictly forbidden as openers:
  ✗ "Midday reminder:" / "Morning reminder:" / "Evening reminder:"
  ✗ "Daily check-in:" / "Check-in:" / "Reminder:" / "Note:"
  ✗ "Morning check-in —" / "Midday nudge —" / "Evening wind-down —"
  Start DIRECTLY with the actual message content. No preambles, no categories.`;

    // Anti-repeat block: list the texts of recent reminders so the model
    // writes something genuinely new (deterministic backstop in generate()).
    const recent = (opts?.recentMessages ?? []).filter((m) => m && m.trim().length > 0).slice(0, 5);
    const ANTI_REPEAT = recent.length > 0
      ? `\nRECENTLY SENT (do NOT repeat any of these — not the wording, not the structure, not a close variant):\n${recent.map((m) => `- "${m.slice(0, 160)}"`).join('\n')}\n`
      : '';

    // Conversation relevance: surface what the user recently said so the
    // reminder can follow up on a real topic instead of reading generic. The
    // model MAY weave in ONE relevant thread; it must never invent or force it,
    // and must still obey DATA ACCURACY (no fabricated numbers/symptoms).
    const convo = (opts?.conversationContext ?? []).filter((m) => m && m.trim().length > 0).slice(-5);
    const CONVO_CONTEXT = convo.length > 0
      ? `\nRECENT CONVERSATION (the user's own recent messages — most recent last):\n${convo.map((m) => `- "${m.slice(0, 140)}"`).join('\n')}\nYou MAY gently follow up on ONE of these ONLY if it's a symptom, a feeling, a goal, or something they were working on — and only if it genuinely fits. NEVER reference a specific food or meal they mentioned as if it were TODAY's meal, this morning's breakfast, or "a good start to the day" — a meal they logged is in the PAST, not what they're eating now (e.g. do NOT say "that salmon sounds like a great start to the day"). NEVER invent details beyond what they said. If nothing clearly fits, ignore this and send a normal reminder.\n`
      : '';

    const base = `Write the next short proactive SMS from Grace to this user. Output ONLY the message text.\n${VARIATION_BLOCK}\n\n${RULES}\n${ANTI_REPEAT}${CONVO_CONTEXT}\n`;

    // Wednesday morning: mood check overrides all goal-based routing
    if (type === 'morning' && opts?.isWednesday) {
      return `${base}Context: it's Wednesday — today is always a gentle mood check, regardless of goals. Ask softly how they're feeling mid-week. One warm, open question. No food/protein talk today.`;
    }

    const instructions: Record<MsgType, string> = {
      morning: (() => {
        // Rotating TODAY'S FOCUS (weighted by goals) replaces the old always-protein
        // default so mornings vary across the whole wellness picture, not just food.
        const focus = pickTodaysFocus(user.goals, seed, 'morning');
        const nutritionDay = isNutritionFocus(focus);
        // REAL yesterday data stays in the prompt for AWARENESS, but TOPIC
        // DISCIPLINE forbids reciting it (or pivoting to protein) unless the focus
        // is nutrition — so a hydration/mindset morning won't drag in protein.
        const y = opts?.yesterdayFood;
        let dataBlock = '';
        if (y) {
          if (y.itemCount === 0) {
            dataBlock = `\nREAL DATA — yesterday: no food was logged. If you reference it, keep it shame-free ("fresh start today" energy, never scolding about not logging).`;
          } else {
            const goalPart = y.proteinGoal
              ? y.protein_g >= y.proteinGoal
                ? `they HIT their ${y.proteinGoal}g protein target (${y.protein_g}g)${nutritionDay ? ' — a brief genuine acknowledgment is welcome' : ''}`
                : `they reached ${y.protein_g}g of their ${y.proteinGoal}g protein target (${Math.max(0, y.proteinGoal - y.protein_g)}g short)${nutritionDay ? ' — today is a good day to plan one solid protein meal early' : ''}`
              : `they logged ${y.protein_g}g protein`;
            dataBlock = `\nREAL DATA — yesterday: ${goalPart}. ${y.itemCount} food${y.itemCount === 1 ? '' : 's'} logged.${nutritionDay ? " Use this naturally if helpful; don't recite all the numbers." : " For your AWARENESS only — today's focus is not nutrition, so do NOT recite these numbers or pivot to protein."}`;
          }
        }
        // Yesterday bridge: gently continue yesterday's thread (symptom/emotion)
        // into today so the reminder feels personal. A PROTEIN bridge (yesterday
        // came up short / hit goal) is suppressed on a non-nutrition focus day —
        // that's exactly the over-indexing we're removing — while symptom/emotion
        // continuity always wins and the rotating focus fills the rest.
        const bridge = deriveMorningBridge(user, opts);
        const useBridge = bridge.block.length > 0
          && !((bridge.kind === 'protein' || bridge.kind === 'positive') && !nutritionDay);
        const focusBlock = useBridge ? bridge.block : buildFocusBlock(focus);
        const closer = (useBridge && bridge.allowQuestion)
          ? 'At most ONE short, gentle question is fine today; never stack questions.'
          : 'No questions.';
        return `${base}Context: gentle morning hello.${focusBlock}${dataBlock} ${closer}${hook}`;
      })(),
      bonus: (() => {
        const catIdx = (seed + dayOfYear(new Date())) % BONUS_CATEGORIES.length;
        const category = BONUS_CATEGORIES[catIdx]!;
        const catHints: Record<string, string> = {
          hydration: 'a hydration nudge — GLP-1s suppress thirst. One practical water tip.',
          protein_tip: `a protein idea they haven't heard. Target: ${user.protein_goal_grams ?? 80}g daily. Something surprising or easy.`,
          movement: 'a gentle movement reminder — not a workout plan, just encouragement to move a little.',
          self_care: 'a body-care or self-care thought — sleep, skin, stretching, rest. Something nurturing.',
          glp1_knowledge: `one interesting fact about ${user.medication ?? 'GLP-1 medication'} that's useful and non-obvious. Not clinical.`,
          meal_idea: `one specific easy meal or snack idea. ${dislikes} Filter by their dislikes. Protein-focused.`,
          body_care: 'acknowledge what their body is going through — the adjustment, the changes. Be warm, not medical.',
          micro_goal: 'suggest one tiny concrete thing for the next hour. Achievable, no pressure.',
          acknowledgment: 'pure acknowledgment — they\'re showing up and that matters. No tips, no advice.',
          mindfulness: 'a gentle mindfulness moment — one breath, one pause, noticing how the body feels. Brief.',
        };
        return `${base}Context: spontaneous check-in at an unexpected time. Today's theme: ${catHints[category] ?? 'warm presence.'} This is a BONUS touch point — extra brief, extra casual. Must feel like a random thoughtful text from a friend, not a scheduled message. ONE sentence only.`;
      })(),
      midday: (() => {
        const focus = pickTodaysFocus(user.goals, seed, 'midday');
        return `${base}Context: midday nudge (Mon/Wed/Fri). Keep it brief — a soft "thinking of you."${buildFocusBlock(focus)}${isNutritionFocus(focus) && dislikes ? ` ${dislikes} If you mention food, filter by their dislikes.` : ''} NO questions.`;
      })(),
      evening: (() => {
        const focus = pickTodaysFocus(user.goals, seed, 'evening');
        const nutritionDay = isNutritionFocus(focus);
        const weightCtx = user.current_weight && user.goal_weight
          ? `They're ${Math.abs(user.current_weight - user.goal_weight).toFixed(0)} lbs from their goal (currently ${user.current_weight} lbs, aiming for ${user.goal_weight} lbs). Gently acknowledge progress ONLY if it feels natural and fits the focus.`
          : '';
        const moodCtx = opts?.lowMoodMode
          ? 'Their recent mood data shows they\'ve been struggling. Lead with encouragement and warmth — no reflection prompts, no "how did today go?". Just presence.'
          : 'Soft wind-down tone. Optional one-word-answer question max, or none.';
        // REAL same-day data stays for AWARENESS, but the wrap-up only recites the
        // protein number / suggests food when the focus is nutrition — otherwise
        // the evening winds down on the rotating focus (rest, mindset, etc.).
        const t = opts?.todayFood;
        let dataBlock = '';
        if (t) {
          if (t.itemCount === 0) {
            dataBlock = nutritionDay
              ? `\nREAL DATA — today: nothing logged yet. A gentle, shame-free nudge that they can still text you what they ate is welcome. Do NOT pretend to know what they ate.`
              : `\nREAL DATA — today: nothing logged yet (for your AWARENESS only — today's focus is not nutrition, so do NOT bring up food or logging).`;
          } else {
            const goalPart = t.proteinGoal
              ? t.protein_g >= t.proteinGoal
                ? `they're at ${t.protein_g}g protein — target (${t.proteinGoal}g) already hit${nutritionDay ? '. Acknowledge it; no food suggestion needed' : ''}`
                : `they're at ${t.protein_g}g of their ${t.proteinGoal}g protein target${nutritionDay ? '. If they\'re still eating tonight, ONE simple suggestion (eggs, Greek yogurt, cottage cheese — filtered by dislikes) could close the gap' : ''}`
              : `they're at ${t.protein_g}g protein today`;
            dataBlock = `\nREAL DATA — today: ${goalPart}. ${t.itemCount} food${t.itemCount === 1 ? '' : 's'} logged so far.${nutritionDay ? '' : " For your AWARENESS only — today's focus is not nutrition, so do NOT recite these numbers or bring up protein."}`;
          }
        }
        return `${base}Context: evening wind-down — a daily check-in that wraps the day, NOT a repeat of this morning's message.${buildFocusBlock(focus)} ${weightCtx} ${moodCtx}${dataBlock}${nutritionDay ? ` ${dislikes} If suggesting evening food, filter by dislikes.` : ''}${hook}`;
      })(),
      injection_morning: `${base}Context: injection day reminder. Their medication is ${user.medication ?? 'a GLP-1'}.${opts?.injectionNumber ? ` This is injection #${opts.injectionNumber} — you MAY mention the number.` : ' Do NOT mention an injection number (you don\'t know it).'} Remind them to rotate to a DIFFERENT injection site than last time, and to keep a few comfort items handy just in case (ginger tea, plain crackers, electrolytes). Tell them to reply "done" when injected. Warm and brief, 1-3 sentences. No questions about feelings — that comes later.${opts?.symptomHeadsUp ?? ''}`,
      injection_followup: `${base}Context: a check-in after their shot (a few hours later, or the next morning if they injected late). Do NOT assume a specific number of hours. Just check in softly — no interrogation. One brief opening for them to share if they want.`,
      injection_dayafter: `${base}Context: morning after injection. Acknowledge that day-after can be tough, be gentle. No checklist questions.`,
      side_effect_nausea: `${base}Context: they reported nausea earlier. Soft follow-up only — no question stack. Offer one practical tip in passing.`,
      side_effect_fatigue: `${base}Context: they reported fatigue. Validate it's real, suggest one gentle helper. No quiz.`,
      side_effect_constipation: `${base}Context: they reported constipation. Soft check-in with one tip woven in. No question barrage.`,
      welcome: `${base}Context: their very first message ever from Grace. This sets the tone for the whole relationship — make it count.

Structure (2-3 short paragraphs, separated by blank lines):
1. Warm greeting using their first name ONCE + mention their medication (${user.medication ?? 'GLP-1'})
2. Explain what Grace does: 1-2 light check-ins per day, plus they can text anytime about food, symptoms, weight, or feelings. Photos and voice notes work.
3. Set expectations: no pressure to reply, even short replies work, you're here when needed

Tone: confident, warm, human. Not gushing or salesy. Make them feel supported immediately.
${dislikes ? `If you reference food dislikes, paraphrase naturally — never echo their text verbatim.` : ''}
Do NOT ask a question. Do NOT send a second follow-up.`,
      trial_expiry_reminder: (() => {
        const upgradeUrl = buildUpgradeUrl(user.phone, this.webUrl);
        return `${base}Context: this is Day 2 of the user's 3-day free trial — their trial ends tomorrow. Send a warm, pressure-free reminder that their trial ends tomorrow and they can subscribe at ${upgradeUrl}. ALWAYS include the literal URL ${upgradeUrl} — never write a placeholder. NEVER use their name. NEVER use "upgrade" language — say "continue" or "keep going." NEVER exclamation marks. NEVER salesy tone. ONE or TWO short sentences max. Example: "Your Grace trial ends tomorrow 🧡 Head to ${upgradeUrl} anytime to keep your check-ins going."`;
      })(),
      journey: (() => {
        const day = opts?.journeyDay ?? 1;
        const goalByDay: Record<number, string> = {
          1: "This is their FIRST full day with you. Goal: get them to log their first meal. Warmly invite them to just text you their next meal (or snap a photo) and you'll handle the protein. Make it feel easy and genuinely exciting — the start of something good.",
          2: 'Day 2. Teach ONE small, useful GLP-1 trick (e.g. protein-first at a meal keeps you fuller) and invite them to try it today. Curious and friendly, ONE idea only.',
          3: "Day 3. Show off something that delights: they can send a PHOTO of any meal and you'll break down the protein for them. Invite them to try it. Light and fun.",
        };
        return `${base}Context: guided first-week journey. ${goalByDay[Math.min(3, Math.max(1, day))]} Warm, a little excited, ONE clear easy action. A single friendly invite/question is welcome here.`;
      })(),
      winback: (() => {
        const stage = opts?.winbackStage ?? 1;
        const toneByStage: Record<number, string> = {
          1: 'They\'ve been quiet about a day. Light, warm "thinking of you", zero guilt. Leave an easy open door to jump back in.',
          2: "They've been quiet a few days. Warm and reassuring — no guilt, life gets busy. Make restarting feel effortless (even one quick text).",
          3: "They've been quiet about a week. Genuinely warm \"I'm still here\", no catching-up required — you just start from today. Never guilt-trip, never desperate.",
        };
        return `${base}Context: win-back — gently re-engage a user who's gone quiet. ${toneByStage[Math.min(3, Math.max(1, stage))]} If the RECENT CONVERSATION below shows something they were working on or mentioned, you MAY reference it warmly to reconnect — never invent. A single soft invite is fine. NEVER guilt, NEVER a corporate "we miss you" tone.`;
      })(),
    };

    return instructions[type] + (opts?.extra ? `\n\nExtra context: ${opts.extra}` : '');
  }
}

// ─── Output sanitizer ────────────────────────────────────────────────────────
// Two failure modes from the LLM that this guards against:
//   1. Forbidden internal labels leaking into the message ("Midday reminder:",
//      "Morning check-in —", etc). The system prompt forbids these but Gemini
//      still emits them ~5% of the time, so we strip them deterministically.
//   2. Truncation mid-sentence (output budget exhausted). We detect by
//      requiring the message ends with punctuation, an emoji, or a closing
//      quote — anything else means it was cut off and we fall back.
const FORBIDDEN_LABEL_PREFIX = /^(morning|midday|afternoon|evening|night|daily|weekly|injection|protein|hydration|side[\s-]?effect|bonus|spontaneous)\s+(reminder|check[\s-]?in|nudge|note|update|message|hello|hi|thought)[\s:.\-—–,]+/i;
const GENERIC_LABEL_PREFIX = /^(reminder|check[\s-]?in|note|update|hey there)[\s:,.\-—–]+/i;
// Note: COMPLETE_ENDING regex was replaced by the shared endsMidWord guard
// imported from @grace/ai-core (2026-06-04 unification).

// Production failure (2026-06-11): a reminder shipped as "For Yuval, Hope
// you're having a good day…" — the LLM echoed the prompt's addressing line
// as a mail-merge-style salutation. These catch that whole class of opener
// regardless of which name the model used (covers nicknames that don't match
// users.first_name).
// Capitalized-name requirement is deliberate (no `i` flag on the name): it
// distinguishes "For Yuval," (salutation → strip) from a legitimate
// "For breakfast, try…" (lowercase noun → keep).
const ADDRESSED_OPENER_RE = /^(For|Dear|To|for|dear|to)\s+[A-Z][\w'’-]*\s*[,:;.!—–-]+\s*/;
const ROLE_OPENER_RE = /^(dear\s+(user|friend|there)|as your (ai\s+)?(assistant|companion|coach|nutritionist)|this is grace[,:]?|grace here[,:]?)\s*[,:;.!—–-]*\s*/i;

function sanitizeProactiveOutput(raw: string, firstName: string | null): string | null {
  let text = raw.trim();
  if (text.length === 0) return null;

  // Strip wrapping quotes Gemini sometimes adds.
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }

  // Strip a forbidden label-style prefix if present, then re-trim.
  const before = text;
  text = text.replace(FORBIDDEN_LABEL_PREFIX, '').replace(GENERIC_LABEL_PREFIX, '').trim();
  // Mail-merge salutations ("For Yuval,", "Dear user,", "As your assistant,")
  // — strip whatever name the model used, then the role-style openers.
  text = text.replace(ADDRESSED_OPENER_RE, '').replace(ROLE_OPENER_RE, '').trim();
  // Capitalize first letter if the strip left it lowercase mid-word.
  if (before !== text && text.length > 0) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }

  // Strip the user's first name wherever it appears — it's forbidden in every
  // proactive message except welcome. The LLM violates this rule ~10% of the
  // time despite the prompt instruction, so we enforce it in code too.
  if (firstName) {
    const n = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // "Morning Danni 🌿 ..." → "Morning 🌿 ..."  |  "Hey Danni — ..." → "..."
    text = text.replace(new RegExp(`(Morning|Evening|Hey|Hi|Hello),?\\s+${n}[,\\s—–]\\s*`, 'gi'), '$1 ');
    // Any remaining standalone name occurrence with surrounding punctuation
    text = text.replace(new RegExp(`\\b${n}[,—–]\\s*`, 'gi'), '');
    text = text.replace(/\s{2,}/g, ' ').trim();
  }

  // Reject too-short results (likely the prefix was the entire message).
  if (text.length < 15) return null;

  // 2026-06-04 unified mid-sentence check: use the same endsMidWord guard
  // the orchestrator uses, so proactive messages get the SAME protection
  // against (approx., unclosed brackets, stranded hedge words, etc.
  // Iterative trim — same logic as the orchestrator's final safety net.
  if (endsMidWord(text)) {
    let candidate = text;
    let cleaned = false;
    for (let i = 0; i < 6; i++) {
      const { trimmed, wasTrimmed } = trimToLastCompleteSentence(candidate);
      if (!wasTrimmed || trimmed.length < 15) break;
      candidate = trimmed;
      if (!endsMidWord(candidate)) { cleaned = true; break; }
    }
    if (cleaned) return candidate;
    return null;
  }

  return text;
}

// trimToLastCompleteSentence is now imported from @grace/ai-core (2026-06-04
// unification), so the proactive path uses the EXACT SAME completeness check
// as the orchestrator.

// ─── Near-duplicate detection ────────────────────────────────────────────────
// A reminder must never repeat one of the last few sent to the same user.
// Exact match after normalization, or ≥85% token overlap (Jaccard) — catches
// "Protein first today 🌿" vs "Protein first today 🤍" style trivial rewrites.
function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isNearDuplicate(a: string, b: string): boolean {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na.length === 0 || nb.length === 0) return false;
  if (na === nb) return true;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.85;
}

// Test-only exports — let unit tests drive the sanitizer directly without a
// real LLM round-trip.
export const __testing = {
  sanitizeProactiveOutput,
};
