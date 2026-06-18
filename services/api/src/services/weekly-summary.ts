import { isEncryptedBlob } from '../crypto/field-encrypt.js';

/**
 * Weekly / recent-history summary service (2026-06-18).
 *
 * Answers requests like "give me a summary of how my last week was",
 * "how have I been doing", "recap my week for my doctor", and the
 * comprehensive-continuation "add all the data you have to make it
 * comprehensive". Before this existed, those requests fell through to:
 *   - a single-day "you've had 12g of protein today" answer (wrong window), OR
 *   - the generic `general` fallback ("Tell me more whenever you're ready"),
 *     which misread an instruction-to-compile-data as the user offering more.
 *
 * Design mirrors food-summary.ts / reminder-service.ts:
 *   - Detection is cheap pure regex (no I/O).
 *   - Data gathering is best-effort per source — a DB hiccup on any one source
 *     degrades that line, never the whole summary.
 *   - Rendering is ONE block of clean WhatsApp prose: no headers, no bullets,
 *     no "Label:" colons, no list intros, and kept short enough to survive the
 *     outbound enforcer's ~420-char cap (a "comprehensive" summary covers every
 *     data point tersely — it is NOT a sectioned report, which the enforcer
 *     would gut to nothing).
 *
 * Grace OWNS explanation only. This summary READS logged data — it never
 * writes, never logs food, and never invents numbers it doesn't have.
 */

// ─── Detection ────────────────────────────────────────────────────────────────

// Explicit "summarize my recent stretch" requests. Requires a period word
// (week / month / lately / recent / progress) so "what did I eat today" — owned
// by the daily food summary — does NOT match here.
const SUMMARY_PERIOD_RE =
  /\b(summary|summari[sz]e|recap|overview|rundown|wrap[\s-]?up|how (?:was|were|has|have|did|are|am i doing)|how'?s my)\b[^?.!]{0,40}\b(week|last week|past week|this week|month|last month|lately|recently|recent|progress|journey|so far|going|doing|been doing)\b/i;

// "how was my week" / "how has my week been" — period first, verb after.
const PERIOD_FIRST_RE =
  /\b(my|the|this|last|past)\s+(week|month)\b[^?.!]{0,30}\b(go|going|gone|been|look|looking|been like|treat|been treating)\b/i;

// "summarize my data / my week / my progress / my month" — verb first.
const SUMMARIZE_TARGET_RE =
  /\b(summari[sz]e|recap|sum up|wrap up|give me (?:a |an )?(?:summary|recap|overview|rundown|picture|breakdown))\b[^?.!]{0,40}\b(week|month|progress|data|numbers|stats|journey|everything|how i'?ve been)\b/i;

// Strong, standalone data-compilation language. These fire on their own (no
// history needed) — "all the data you have", "make it comprehensive",
// "the full picture", "include everything", "as detailed as possible".
const DATA_COMPILE_RE =
  /\b(all (?:the |my |of (?:the|my) )?(?:data|info(?:rmation)?|details|numbers|stats)(?:\s+you\s+(?:have|know|got))?|everything you (?:have|know|got|can)|(?:make|keep) it (?:comprehensive|detailed|thorough|complete|as detailed as possible|as comprehensive as possible|in[\s-]?depth)|comprehensive (?:summary|report|overview|breakdown|picture|rundown)|(?:the )?(?:full|whole|complete|entire) (?:picture|summary|report|breakdown|rundown|history)|as (?:much|many) (?:detail|data|info)|include everything|add (?:in )?(?:all|more) (?:the )?(?:data|detail|details|info))\b/i;

// Weaker continuation phrases that ONLY count as a summary request when the
// recent conversation was already about a summary / appointment / data recap.
const WEAK_CONTINUATION_RE =
  /\b(more detail|more details|expand (?:on )?(?:that|it)|go deeper|add to (?:that|it)|build on (?:that|it)|flesh (?:that|it) out|in more depth)\b/i;

// Markers that the recent conversation is a summary / appointment-prep / data
// recap context — used to confirm WEAK_CONTINUATION_RE.
const SUMMARY_CONTEXT_RE =
  /\b(summary|summari[sz]e|recap|overview|comprehensive|appointment|doctor|endocrinologist|provider|prescriber|last week|past week|this week|your (?:week|month|protein|weight|dose|mood)|how (?:was|has) (?:your|my) week|prep|prepare)\b/i;

/**
 * Decide whether a message is a recent-history / weekly summary request.
 *
 * `recentContext` (optional) is a blob of the last few turns (user + assistant)
 * used only to confirm weak continuation phrases. Strong forms (explicit
 * summary requests, "all the data you have", "make it comprehensive") fire
 * without it.
 *
 * Returns `true` when Grace should produce a data-grounded weekly summary.
 */
export function detectSummaryRequest(text: string, recentContext?: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  // Don't hijack a clear single-day food question ("what did I eat today").
  if (/\btoday\b/i.test(t) && !/\b(week|month|comprehensive|all (?:the|my) data)\b/i.test(t)) {
    return false;
  }
  if (
    SUMMARY_PERIOD_RE.test(t) ||
    PERIOD_FIRST_RE.test(t) ||
    SUMMARIZE_TARGET_RE.test(t) ||
    DATA_COMPILE_RE.test(t)
  ) {
    return true;
  }
  // Weak continuation only counts inside an active summary/appointment context.
  if (WEAK_CONTINUATION_RE.test(t) && recentContext && SUMMARY_CONTEXT_RE.test(recentContext)) {
    return true;
  }
  return false;
}

/** Cheap pre-gate so handleMessage only fetches history when a summary is plausible. */
export function mightBeSummaryRequest(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  return (
    SUMMARY_PERIOD_RE.test(t) ||
    PERIOD_FIRST_RE.test(t) ||
    SUMMARIZE_TARGET_RE.test(t) ||
    DATA_COMPILE_RE.test(t) ||
    WEAK_CONTINUATION_RE.test(t)
  );
}

// ─── Data gathering ───────────────────────────────────────────────────────────

export interface WeeklySummaryUser {
  phone: string;
  first_name?: string | null;
  medication?: string | null;
  dose_mg?: number | null;
  injection_day?: string | null;
  protein_goal_grams?: number | null;
  side_effect_flow?: string | null;
  side_effect_flow_started_at?: Date | string | null;
}

export interface WeeklySummaryData {
  daysWindow: number;
  daysLogged: number;
  avgProtein: number | null;
  avgCalories: number | null;
  proteinGoal: number | null;
  weightStart: number | null;
  weightLatest: number | null;
  avgMood: number | null;
  medication: string | null;
  doseMg: number | null;
  injectionDay: string | null;
  sideEffect: string | null;
}

/** Minimal surface of UserService the summary needs (kept narrow for testing). */
export interface WeeklySummaryDeps {
  getDailyProteinHistory(
    userId: string,
    days?: number,
  ): Promise<Array<{ day: string; protein_g: number; calories: number; item_count: number }>>;
  getWeightHistory(
    userId: string,
    limit?: number,
  ): Promise<Array<{ weight: number; created_at: Date }>>;
  getRecentCheckIns(
    userId: string,
    limit?: number,
  ): Promise<Array<{ type: string; mood_score: number | null; created_at: Date }>>;
}

const WEEK_MS = 7 * 24 * 3_600_000;

/**
 * True when a value looks like an encrypted-at-rest field blob
 * (`enc:<iv>:<data>:<tag>` from crypto/field-encrypt.ts) rather than a real
 * plaintext value. Happens when the running process can't decrypt a stored
 * field (FIELD_ENCRYPTION_KEY missing or rotated). We must NEVER surface such a
 * blob to a user — treat it as "unknown" instead. Delegates to the canonical
 * detector in the crypto module so the two never drift.
 */
export function looksEncrypted(value: string | null | undefined): boolean {
  return isEncryptedBlob(value);
}

/**
 * Pull the user's real last-7-days data. Every source is best-effort: a failure
 * leaves its fields null and the renderer simply omits that line.
 */
export async function gatherWeeklySummary(
  deps: WeeklySummaryDeps,
  user: WeeklySummaryUser,
  now: Date = new Date(),
): Promise<WeeklySummaryData> {
  const daysWindow = 7;
  const data: WeeklySummaryData = {
    daysWindow,
    daysLogged: 0,
    avgProtein: null,
    avgCalories: null,
    proteinGoal: user.protein_goal_grams ?? null,
    weightStart: null,
    weightLatest: null,
    avgMood: null,
    // Guard against a non-decrypted field blob leaking into the reply: if the
    // medication came back as ciphertext (encryption key missing/rotated in the
    // running process), omit it rather than show "enc:..." to the user.
    medication: looksEncrypted(user.medication) ? null : (user.medication ?? null),
    doseMg: user.dose_mg ?? null,
    injectionDay: user.injection_day ?? null,
    sideEffect: null,
  };

  // Protein / calories
  try {
    const hist = await deps.getDailyProteinHistory(user.phone, daysWindow);
    const logged = hist.filter((d) => d.item_count > 0);
    data.daysLogged = logged.length;
    if (logged.length > 0) {
      data.avgProtein = Math.round(logged.reduce((s, d) => s + d.protein_g, 0) / logged.length);
      const calLogged = logged.filter((d) => d.calories > 0);
      if (calLogged.length > 0) {
        data.avgCalories = Math.round(calLogged.reduce((s, d) => s + d.calories, 0) / calLogged.length);
      }
    }
  } catch { /* best-effort */ }

  // Weight trend within the window (earliest vs latest of the last 7 days)
  try {
    const weights = await deps.getWeightHistory(user.phone, 20);
    const inWindow = weights
      .filter((w) => now.getTime() - new Date(w.created_at).getTime() <= WEEK_MS && Number.isFinite(w.weight))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    if (inWindow.length >= 1) {
      data.weightLatest = inWindow[inWindow.length - 1]!.weight;
      if (inWindow.length >= 2) data.weightStart = inWindow[0]!.weight;
    }
  } catch { /* best-effort */ }

  // Mood (check_ins carrying a mood_score within the window)
  try {
    const checkins = await deps.getRecentCheckIns(user.phone, 40);
    const moods = checkins
      .filter(
        (c) =>
          c.mood_score != null &&
          now.getTime() - new Date(c.created_at).getTime() <= WEEK_MS,
      )
      .map((c) => c.mood_score!);
    if (moods.length > 0) {
      data.avgMood = Math.round((moods.reduce((s, m) => s + m, 0) / moods.length) * 10) / 10;
    }
  } catch { /* best-effort */ }

  // Active side-effect flag (only the current one is persisted, qualitatively)
  if (user.side_effect_flow) {
    const startedMs = user.side_effect_flow_started_at
      ? new Date(user.side_effect_flow_started_at).getTime()
      : now.getTime();
    if (now.getTime() - startedMs <= WEEK_MS) data.sideEffect = user.side_effect_flow;
  }

  return data;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function titleCaseMed(med: string): string {
  return med.charAt(0).toUpperCase() + med.slice(1);
}

/**
 * Render the gathered data as one clean prose block. Enforcer-safe:
 *   - no headers, no bullets, no "Label:" colons, no list intros
 *   - flowing sentences, kept terse so it survives the ~420-char outbound cap
 *   - omits any line we have no data for (never fabricates)
 *
 * When there's essentially nothing logged, returns an honest "not much yet"
 * message that still offers a useful next step (doctor questions).
 */
export function renderWeeklySummary(data: WeeklySummaryData): string {
  const sentences: string[] = [];

  const hasNutrition = data.daysLogged > 0 && data.avgProtein != null;
  const hasWeight = data.weightLatest != null;
  const hasMood = data.avgMood != null;

  if (hasNutrition) {
    let s = `Over the last ${data.daysWindow} days you logged food on ${data.daysLogged} of ${data.daysWindow} days, averaging ${data.avgProtein}g protein`;
    if (data.avgCalories != null) s += ` and about ${data.avgCalories.toLocaleString('en-US')} calories a day`;
    if (data.proteinGoal != null) {
      s += data.avgProtein! >= data.proteinGoal
        ? `, right around your ${data.proteinGoal}g goal`
        : `, a bit under your ${data.proteinGoal}g goal`;
    }
    sentences.push(s + '.');
  }

  if (hasWeight) {
    if (data.weightStart != null && data.weightStart !== data.weightLatest) {
      const delta = Math.round((data.weightStart - data.weightLatest!) * 10) / 10;
      if (delta > 0) {
        sentences.push(`Your weight went from ${data.weightStart} to ${data.weightLatest} lbs, down ${delta} this week.`);
      } else {
        sentences.push(`Your weight moved from ${data.weightStart} to ${data.weightLatest} lbs this week.`);
      }
    } else {
      sentences.push(`Your latest logged weight is ${data.weightLatest} lbs.`);
    }
  }

  if (hasMood) {
    sentences.push(`Mood's averaged around ${data.avgMood} out of 10.`);
  }

  // Medication / dose / injection day — one combined sentence.
  if (data.medication) {
    let s = `You're on ${titleCaseMed(data.medication)}`;
    if (data.doseMg != null) s += ` at ${data.doseMg}mg`;
    if (data.injectionDay) s += `, injection day ${data.injectionDay}`;
    sentences.push(s + '.');
  } else if (data.doseMg != null) {
    sentences.push(`You're on a ${data.doseMg}mg dose${data.injectionDay ? `, injection day ${data.injectionDay}` : ''}.`);
  }

  if (data.sideEffect) {
    sentences.push(`You also flagged ${data.sideEffect} this week.`);
  }

  // Nothing real to report → honest, still-useful answer.
  if (sentences.length === 0) {
    return (
      `I don't have much logged from the past week yet, so I can't pull together a full picture. ` +
      `Log a few meals and your weight and I'll have real numbers for you. ` +
      `Want a few solid questions to bring to your doctor in the meantime?`
    );
  }

  sentences.push(`Want me to turn this into a few questions for your doctor?`);
  return sentences.join(' ');
}
