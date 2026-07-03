// Pure, client-side derivations for the dashboard. Everything here is computed
// from the existing `/dashboard/summary` payload — NO new backend calls, no
// fabricated data. Used to power the Today Overview hero, the Grace insight
// card, the injection countdown, wins, and the profile-completeness meter.
//
// Kept dependency-free and side-effect-free so it's trivially safe to reason
// about and can't affect any other part of the app.

import type { DashboardSummary } from "./dashboardApi";

const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];

/** Clamp a value/goal ratio to an integer 0–100 percentage. Goal ≤ 0 → 0. */
export function ringPct(value: number, goal: number | null | undefined): number {
  if (!goal || goal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / goal) * 100)));
}

export interface InjectionCountdown {
  /** Full weekday name as stored, e.g. "Monday". */
  weekday: string;
  /** 0 = today, 1 = tomorrow, … up to 6. */
  daysUntil: number;
  isToday: boolean;
  isTomorrow: boolean;
  /** Human label, e.g. "Today", "Tomorrow", "in 3 days", "Monday". */
  label: string;
}

/**
 * Derive the next injection occurrence from the stored weekday name.
 * Weekly cadence assumed (the app's model). Returns null when we don't have a
 * parseable weekday, so callers can hide the section cleanly.
 */
export function injectionCountdown(
  injectionDay: string | null | undefined,
  now: Date = new Date(),
): InjectionCountdown | null {
  if (!injectionDay) return null;
  const key = injectionDay.trim().toLowerCase();
  // Accept both "monday" and 3-letter "mon".
  let target = WEEKDAYS.indexOf(key);
  if (target === -1) target = WEEKDAYS.findIndex((d) => d.startsWith(key.slice(0, 3)));
  if (target === -1) return null;

  const today = now.getDay();
  const daysUntil = (target - today + 7) % 7;
  const weekday = WEEKDAYS[target].charAt(0).toUpperCase() + WEEKDAYS[target].slice(1);
  const label =
    daysUntil === 0 ? "Today"
    : daysUntil === 1 ? "Tomorrow"
    : daysUntil <= 3 ? `in ${daysUntil} days`
    : weekday;
  return { weekday, daysUntil, isToday: daysUntil === 0, isTomorrow: daysUntil === 1, label };
}

export interface Win {
  icon: string;
  text: string;
}

/**
 * Small, honest celebrations pulled from real data. Only surfaces a win when
 * the underlying number genuinely earns it (never manufactures encouragement).
 */
export function computeWins(data: DashboardSummary): Win[] {
  const wins: Win[] = [];
  const n = data.nutrition;
  const w = data.weight;

  if (w.lostLbs != null && w.lostLbs > 0) {
    wins.push({ icon: "📉", text: `Down ${round1(w.lostLbs)} lb since you started` });
  }
  if (n.streak >= 3) {
    wins.push({ icon: "🔥", text: `${n.streak}-day logging streak` });
  }
  if (n.proteinGoal > 0 && n.today.protein >= n.proteinGoal) {
    wins.push({ icon: "💪", text: "Protein goal hit today" });
  }
  if (w.pct != null && w.pct >= 25) {
    wins.push({ icon: "🎯", text: `${Math.round(w.pct)}% of the way to your goal` });
  }
  if (data.symptoms.patterns.length > 0) {
    wins.push({
      icon: "🧠",
      text: `Grace has learned ${data.symptoms.patterns.length} of your body's patterns`,
    });
  }
  const loggedDays = n.history.filter((d) => d.itemCount > 0).length;
  if (loggedDays >= 5 && n.streak < 3) {
    wins.push({ icon: "📅", text: `${loggedDays} days logged in the last stretch` });
  }
  return wins.slice(0, 4);
}

export interface GraceInsight {
  /** The single most useful, human line for right now. */
  text: string;
  /** Visual tone hint for the caller. */
  tone: "clay" | "sage" | "ink";
}

/**
 * Grace's one-line read on the user's day. Priority order surfaces the most
 * actionable, time-relevant thing first. Every branch is grounded in a real
 * field — unit-free (protein g / streak / injection / symptom) so it never
 * mis-renders a weight unit.
 */
export function graceInsight(data: DashboardSummary, now: Date = new Date()): GraceInsight {
  const n = data.nutrition;
  const inj = injectionCountdown(data.profile.injectionDay, now);
  const hour = now.getHours();

  if (inj?.isToday) {
    return { text: "Today's your shot day. However you feel after, tell Grace — she'll remember it.", tone: "clay" };
  }
  if (inj?.isTomorrow) {
    return { text: "Shot day is tomorrow. A good protein day and some water make it land easier.", tone: "clay" };
  }

  const proteinLeft = n.proteinGoal > 0 ? n.proteinGoal - n.today.protein : 0;
  if (n.today.protein === 0 && hour >= 11) {
    return { text: "No meals logged yet today. Even a quick line to Grace keeps your streak alive.", tone: "ink" };
  }
  if (proteinLeft > 0 && proteinLeft <= 25 && n.today.protein > 0) {
    return { text: `You're just ${Math.round(proteinLeft)}g from your protein goal — an egg or Greek yogurt closes it.`, tone: "clay" };
  }
  if (n.proteinGoal > 0 && n.today.protein >= n.proteinGoal) {
    return { text: "Protein goal hit for today — that's the habit that protects your muscle. Nice.", tone: "sage" };
  }
  if (n.streak >= 3) {
    return { text: `${n.streak} days logging in a row. That consistency is exactly what moves the needle.`, tone: "sage" };
  }

  const timedPattern = data.symptoms.patterns.find((p) => p.typicalTiming);
  if (timedPattern) {
    return {
      text: `Grace has noticed your ${timedPattern.symptom} usually hits ${timedPattern.typicalTiming}${timedPattern.topRemedy ? ` — ${timedPattern.topRemedy} helped before` : ""}.`,
      tone: "sage",
    };
  }
  if (proteinLeft > 25 && n.today.protein > 0) {
    return { text: `${Math.round(proteinLeft)}g of protein to go today. You've got room for one solid meal.`, tone: "ink" };
  }
  return { text: "Text Grace anytime — meals, symptoms, or just how your day's going. It all lands here.", tone: "ink" };
}

/**
 * The next single action worth nudging, for the hero's "next" chip. Short.
 */
export function nextBestAction(data: DashboardSummary, now: Date = new Date()): string | null {
  const n = data.nutrition;
  const inj = injectionCountdown(data.profile.injectionDay, now);
  if (inj?.isToday) return "Log how you feel after your shot";
  if (n.today.protein === 0) return "Log your first meal";
  const left = n.proteinGoal - n.today.protein;
  if (left > 0) return `Add ${Math.round(left)}g protein`;
  if (data.weight.series.length === 0) return "Log a weigh-in";
  return null;
}

export interface ProfileCompleteness {
  pct: number;
  known: string[];
  missing: Array<{ key: string; label: string; hint: string }>;
}

/**
 * "Grace is learning you" — which profile signals are set vs. still missing.
 * Reads only fields present in the summary payload.
 */
export function profileCompleteness(data: DashboardSummary): ProfileCompleteness {
  const p = data.profile;
  const w = data.weight;
  const fields: Array<{ key: string; label: string; hint: string; set: boolean }> = [
    { key: "name", label: "Your name", hint: "So Grace can greet you by name", set: !!p.firstName },
    { key: "medication", label: "Medication", hint: "Tailors your GLP-1 guidance", set: !!p.medication },
    { key: "injectionDay", label: "Injection day", hint: "Powers shot-day check-ins", set: !!p.injectionDay },
    { key: "goal", label: "Goal weight", hint: "Tracks how far you've come", set: w.goal != null },
    { key: "start", label: "Starting weight", hint: "Anchors your progress", set: w.start != null },
    { key: "primaryGoal", label: "Primary goal", hint: "Focuses Grace's advice", set: !!p.primaryGoal },
  ];
  const known = fields.filter((f) => f.set).map((f) => f.label);
  const missing = fields.filter((f) => !f.set).map(({ key, label, hint }) => ({ key, label, hint }));
  const pct = Math.round((known.length / fields.length) * 100);
  return { pct, known, missing };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
