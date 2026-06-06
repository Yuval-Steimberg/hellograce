// ────────────────────────────────────────────────────────────────────────────
// AIOrchestrator — the core AI response generation engine.
//
// This is the central pipeline that turns a user message into a Grace response.
// Flow: classify → plan → execute tools → generate LLM response → enforce
// format → check content rules → check grounding → check relevance → regen
// if any check fails → web search fallback → safe fallback.
//
// Pure module: no DB, no env reads, no network I/O except LLM calls. All
// external deps (user data, RAG, tool implementations) are injected by
// ai.service.ts which calls orchestrator.run().
// ────────────────────────────────────────────────────────────────────────────

import type {
  ChatTurn,
  CriticReport,
  LLMProvider,
  OrchestratorInput,
  OrchestratorOutput,
  PlannerDecision,
  RetrievedDoc,
  ToolResult,
} from '@grace/shared';
import { checkContent, buildContentRegenInstruction, type ContentViolation } from './content-checker.js';
import { classifyMessage, type MessageType } from './classify.js';
import { LLMCritic } from './critic.js';
import { BehavioralGuard } from './behavioral-guard.js';
import { checkResponseQuality } from './quality-guard.js';
import { RelevanceChecker } from './relevance-check.js';
import { enforceFormat } from './format-enforcer.js';
import { precheckGrounding, summarizeUnsupported, type GroundingResult } from './grounding.js';
import { PlannerAgent } from './planner.js';
import { GRACE_SYSTEM_PROMPT, renderHistory, renderRetrievalContext } from './prompts.js';
import { ToolRegistry } from './tools/registry.js';
import { validateResponse, type ValidationResult } from './validator.js';

export interface OrchestratorDeps {
  llm: LLMProvider;
  tools: ToolRegistry;
  planner?: PlannerAgent;
  critic?: LLMCritic;
  /** Optional structured logger — currently used only for regen-reason
   *  diagnostics so production telemetry can attribute the ~1.6s retry tax
   *  to specific violations (truncation / topic drift / content rule / etc.).
   *  Any pino-compatible logger works; calls are guarded with `?.` so a
   *  missing logger never breaks the pipeline. */
  logger?: { info?: (obj: unknown, msg: string) => void };
  /** 2026-06-04 TRUST GEMINI flags. Pass these in from env. When trustGemini
   *  is true, ALL three LLM-as-judge guards are bypassed regardless of the
   *  individual flags. Granular flags let you disable one guard at a time. */
  guards?: {
    trustGemini?: boolean;
    behavioralEnabled?: boolean;
    relevanceEnabled?: boolean;
    qualityStrict?: boolean;
  };
}

// Typed fallbacks — each message type gets contextually appropriate recovery
// text so users never see "can you rephrase?" after logging a meal.
// Per-intent fallbacks — fired when LLM + regen + web-search ALL fail.
// These exist to keep Grace from going silent, but they are the LAST thing
// the user sees on a failure — so they MUST follow three rules:
//
//   1. NEVER lie. "Give me a moment, I'll get that right for you" promises
//      a follow-up that never arrives. Banned.
//   2. NEVER topic-switch. "Logged. How's your day going?" after a food log
//      ignores what the user said. Banned.
//   3. NEVER hardcode foods. The food_question fallbacks used to say
//      "Greek yogurt, cottage cheese, or eggs" which violated vegan/vegan-
//      restricted users and produced the forbidden_food safe_fallback we
//      saw in production_issues. Anything food-specific must be deferred
//      to the curated_meal_ideas bank or to a question.
//
// Goal of each fallback: acknowledge briefly, invite continuation honestly,
// or hand back to the user without pretending to know. Auto-eval drilled
// these — every entry below scored ≥3 vs the prior versions' 0-1.5.
const TYPED_FALLBACKS: Record<MessageType, string[]> = {
  food_log: [
    "Logged.",
    "Got that down.",
    "Tracked — say more if you want a protein estimate.",
  ],
  food_question: [
    // Used to hardcode specific foods → vegan/vegetarian users got
    // forbidden_food violations. Now defers back to user for context.
    "What kind of meal are you thinking — breakfast, lunch, dinner, or a snack?",
    "Tell me what you're in the mood for and any restrictions, and I'll pull some options.",
    "Want savory or sweet? Quick or sit-down? Give me a steer.",
  ],
  weight_log: [
    "Tracked.",
    "Got it, that's in.",
    "Logged that one.",
  ],
  mood_log: [
    // 2026-06-06 v2 — Coverage audit follow-up: bare "I hear you." / "Got
    // it. I'm here." / "Noted." are conversational dead-ends. Each entry
    // now recognizes the feeling AND offers a gentle open door so the
    // conversation can continue.
    "Got that. What's been on your mind today?",
    "I hear you. Anything specific weighing on you?",
    "Logged. What's the day been like so far?",
  ],
  greeting: [
    "Hey — how are you doing?",
    "Hi! What's on your mind?",
    "Good to hear from you.",
  ],
  emotional: [
    // 2026-06-06 v2 — Coverage audit follow-up. Bare one-line acks created
    // conversational dead-ends. Each entry now follows the 4-step framework:
    // recognize the feeling + leave a gentle door open for the user to
    // elaborate. No "tell me more" / "what's on your mind?" — those are
    // banned as too lazy.
    "I hear you. What's the heaviest piece of it right now?",
    "That's a lot to be holding. Want to say what's underneath it?",
    "With you on that. Is there a specific piece you can put words to?",
  ],
  scheduling: [
    // Direct link to settings — the prompt rule says scheduling changes go
    // to graceglp.com/settings, fallback should match.
    "You can change check-in frequency at graceglp.com/settings any time.",
    "Settings live at graceglp.com/settings — adjust there and it'll take effect right away.",
  ],
  knowledge: [
    "Muscle loss is common on GLP-1s, with research showing 25-35% of weight lost can be lean mass. Protein (1.2-1.6g/kg daily) and resistance training help shift the balance toward fat loss.",
    "GLP-1s work by mimicking the incretin hormone, slowing gastric emptying and reducing appetite. Side effects like nausea typically peak in the first 4-8 weeks, then improve as your body adjusts.",
    "Protein targets on GLP-1 therapy are higher than normal, around 1.2-1.6g/kg body weight daily. Front-loading 25-30g at breakfast helps protect muscle mass during weight loss.",
  ],
  gibberish: [
    "Didn't quite catch that — what's on your mind?",
    "Say a bit more?",
    "What's going on?",
  ],
  appointment_prep: [
    "Good idea to prep. Bring up your protein intake, side effects (nausea, fatigue, constipation), and ask whether your current dose is still right given how you're feeling. Also worth asking about labs.",
    "A few solid questions: is my current dose still right for me given my progress, what can I do about the side effects I'm feeling, and is muscle loss something I should be testing for. Want me to add a few specific to you?",
  ],
  general: [
    // 2026-06-05 — earlier "Give me a moment to get that right for you" /
    // "Bear with me, pulling that together now" / "One sec, I want to give
    // you a real answer on that" lied about a follow-up the user never got.
    // Auto-eval scored every instance 0.0-1.5 across relevance, persona-
    // awareness, conversational continuity. Replaced with honest brief
    // acknowledgements that don't pretend the LLM didn't just fail.
    "Tell me a bit more?",
    "Say more — I'm with you.",
    "What's the rest of that?",
  ],
  // Phase 1 coverage expansion intents — short, warm fallbacks per type.
  exercise_log: [
    "Nice — every session helps protect muscle on a GLP-1.",
    "Got it, that's a solid one. How did it feel?",
    "Logged. Protein within an hour or two will help with recovery.",
  ],
  injection_log: [
    "Got it, that's done for the week.",
    "Noted. Hydrate well today and protein first if nausea kicks in.",
    "Logged. How are you feeling so far?",
  ],
  medication_question: [
    "Same weekday each week is the rule, the specific hour matters less. Consistency is what keeps the medication steady.",
    "Refrigerate the pen until first use, then it's fine at room temp for up to 28 days (or per your label).",
    "That one's worth a quick call to your prescriber — they can adjust based on your full picture.",
  ],
  social_situation: [
    "Eat protein first, pace yourself, and skip the bread basket if it's not your priority. Most people do best treating it like a regular meal, not a punishment.",
    "Pick one or two foods you actually want, eat slowly, and stop when you're satisfied. The medication will make portions feel smaller than they used to.",
    "Plan ahead lightly, eat protein before you go if it's a long event, and pick the dishes you most want. Skip the rest without guilt.",
  ],
  pause_request: [
    "Got it, I'll pause check-ins. Text me anytime you want to resume.",
    "Taking a break — I'm here when you're ready.",
  ],
};

const _fallbackIdx: Record<string, number> = {};
function getTypedFallback(type: MessageType): string {
  const arr = TYPED_FALLBACKS[type];
  const idx = (_fallbackIdx[type] ?? 0) % arr.length;
  _fallbackIdx[type] = idx + 1;
  return arr[idx]!;
}

/**
 * Tool-aware fallback. When generation fails but a tool ran successfully,
 * we have real data — use it instead of a generic "got it, what else?"
 * which makes Grace look like she ignored what the user just did.
 */
// Detects a body-symptom signal in the user's message. When present, the
// food-log fallback MUST acknowledge the symptom before saying "Logged."
// Production failure 2026-06-05: user said "I had 2 cups of coffee. My
// stomach hurts." → Grace replied "Logged." and ignored the pain.
const SYMPTOM_IN_USER_MSG_RE = /\b(stomach|tummy|belly|gut)\s+(hurts?|aches?|ache|cramping|cramp|upset|sore|burning|in pain)\b|\b(nauseous|nausea|queasy|sick to my stomach|throwing up|threw up|vomiting|vomited)\b|\b(heartburn|acid reflux|reflux|indigestion)\b|\b(headache|migraine|dizzy|lightheaded|woozy)\b|\b(constipated|diarrhea|cramps?)\b/i;

// ─── Diet-aware suggestion banks (2026-06-06) ─────────────────────────────────
// GLP-1 friendly foods tagged by which diets they fit, indexed by meal type.
// Used by every fallback that ships food suggestions (TYPED_FALLBACKS food_
// question, recommendation safety net) so a vegan never gets chicken/salmon
// recommended and a tree-nut-allergic user never gets almonds.
//
// Each entry is filtered through `foodDislikes` (which is also where allergies
// land — Grace stores "allergic to fish" as a dislike). Forbidden-word check
// uses whole-word matching against the food name.
type DietKey = 'omnivore' | 'vegetarian' | 'vegan' | 'pescatarian';
type MealKey = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'general';

const DIET_AWARE_FALLBACK_FOODS: Record<DietKey, Record<MealKey, string[]>> = {
  omnivore: {
    breakfast: [
      'Greek yogurt with hemp seeds',
      'a two-egg veggie omelet',
      'cottage cheese with berries',
      'smoked salmon on rye',
    ],
    lunch: [
      'grilled chicken over greens',
      'a tuna and avocado bowl',
      'turkey and hummus wrap',
      'lentil soup with feta',
    ],
    dinner: [
      'salmon with roasted veg',
      'chicken stir-fry with edamame',
      'steak strips with quinoa',
      'turkey chili',
    ],
    snack: [
      'Greek yogurt with hemp seeds',
      'cottage cheese with berries',
      'a hard-boiled egg with cheese',
      'a tuna packet with cucumber',
    ],
    general: [
      'Greek yogurt with hemp seeds',
      'a two-egg omelet',
      'cottage cheese with berries',
      'a tuna packet',
    ],
  },
  vegetarian: {
    breakfast: [
      'Greek yogurt with hemp seeds',
      'a two-egg veggie omelet',
      'cottage cheese with berries',
      'overnight oats with chia and protein powder',
    ],
    lunch: [
      'lentil soup with feta',
      'paneer and chickpea bowl',
      'a cheese and bean burrito',
      'caprese salad with white beans',
    ],
    dinner: [
      'lentil curry with yogurt',
      'paneer tikka with quinoa',
      'eggplant parmesan with a side of beans',
      'halloumi with roasted veg',
    ],
    snack: [
      'Greek yogurt with hemp seeds',
      'cottage cheese with cucumber',
      'a hard-boiled egg with cheese',
      'edamame with sea salt',
    ],
    general: [
      'Greek yogurt with hemp seeds',
      'cottage cheese with berries',
      'a two-egg omelet',
      'edamame',
    ],
  },
  vegan: {
    breakfast: [
      'tofu scramble with veg',
      'chia pudding with hemp seeds',
      'overnight oats with pea protein',
      'coconut yogurt with berries and almonds',
    ],
    lunch: [
      'a tofu poke bowl',
      'chickpea salad with tahini',
      'a tempeh and avocado wrap',
      'lentil soup with whole-grain bread',
    ],
    dinner: [
      'tofu stir-fry with broccoli',
      'lentil curry with brown rice',
      'tempeh tacos with black beans',
      'a chickpea and spinach stew',
    ],
    snack: [
      'edamame with sea salt',
      'hummus with veggie sticks',
      'roasted chickpeas',
      'a hemp-seed-topped apple',
    ],
    general: [
      'edamame',
      'a tofu poke bowl',
      'hummus with veggie sticks',
      'lentil soup',
    ],
  },
  pescatarian: {
    breakfast: [
      'Greek yogurt with hemp seeds',
      'smoked salmon on rye',
      'a two-egg veggie omelet',
      'cottage cheese with berries',
    ],
    lunch: [
      'a tuna and avocado bowl',
      'a salmon poke bowl',
      'lentil soup with feta',
      'a shrimp salad',
    ],
    dinner: [
      'salmon with roasted veg',
      'shrimp stir-fry with edamame',
      'baked cod with quinoa',
      'tuna steak with greens',
    ],
    snack: [
      'a tuna packet with cucumber',
      'cottage cheese with berries',
      'smoked salmon roll-ups',
      'Greek yogurt with hemp seeds',
    ],
    general: [
      'Greek yogurt with hemp seeds',
      'a tuna packet',
      'salmon with veg',
      'cottage cheese with berries',
    ],
  },
};

const FOLLOWUP_BY_MEAL: Record<MealKey, string> = {
  breakfast: 'Front-load 25-30g of protein to set the day up well.',
  lunch: 'Aim for 25-35g of protein at lunch.',
  dinner: 'Keep the portion modest — slowed digestion fills you faster.',
  snack: 'All protein-forward and easy on slowed digestion.',
  general: 'Protein-forward and easy on slowed digestion.',
};

function pickDietKey(restriction: DietaryRestrictionLite | undefined | null): DietKey {
  if (!restriction) return 'omnivore';
  switch (restriction.label) {
    case 'VEGAN': return 'vegan';
    case 'VEGETARIAN': return 'vegetarian';
    case 'PESCATARIAN': return 'pescatarian';
    default: return 'omnivore';
  }
}

/** Lightweight subset of DietaryRestriction to avoid an import cycle. */
interface DietaryRestrictionLite {
  label: 'VEGAN' | 'VEGETARIAN' | 'PESCATARIAN';
  forbidden: string[];
  allowed: string[];
}

/** Tokenizes user dislikes/allergies into a forbidden word set with sing/plural
 *  variants, so "allergic to nuts" filters out "almonds" via the stem match
 *  on `nut/nuts`. */
function buildForbiddenSet(
  restriction: DietaryRestrictionLite | undefined | null,
  dislikes: string[] | undefined,
): Set<string> {
  const forbidden = new Set<string>();
  const add = (raw: string) => {
    const w = raw.toLowerCase().trim();
    if (w.length < 2) return;
    forbidden.add(w);
    if (w.endsWith('s')) forbidden.add(w.slice(0, -1));
    else forbidden.add(w + 's');
  };
  for (const w of restriction?.forbidden ?? []) add(w);
  for (const raw of dislikes ?? []) {
    // Allergies are stored as dislikes — "allergic to nuts" / "no shellfish".
    // Strip the leading qualifier so we tokenize the food itself.
    const cleaned = raw
      .toLowerCase()
      .replace(/^(?:i'?m\s+)?allergic\s+to\s+/, '')
      .replace(/^(?:i\s+(?:don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(?:like\s+)?|no\s+|avoid\s+|allergy\s+to\s+)/, '')
      .trim();
    for (const tok of cleaned.split(/[\s,]+/).filter(Boolean)) add(tok);
  }
  return forbidden;
}

function foodContainsForbidden(food: string, forbidden: Set<string>): boolean {
  if (forbidden.size === 0) return false;
  const tokens = food.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return tokens.some((t) => forbidden.has(t));
}

/** Builds a diet-and-allergy-safe recommendation line. Returns at least 3
 *  options (after filtering) or null when not enough survive — caller should
 *  fall back to a "tell me what works for you" style line in that case. */
export function buildDietAwareSuggestion(
  mealType: MealKey,
  restriction: DietaryRestrictionLite | undefined | null,
  dislikes: string[] | undefined,
): string | null {
  const dietKey = pickDietKey(restriction);
  const candidates = DIET_AWARE_FALLBACK_FOODS[dietKey][mealType] ?? DIET_AWARE_FALLBACK_FOODS[dietKey].general;
  const forbidden = buildForbiddenSet(restriction, dislikes);
  const survivors = candidates.filter((c) => !foodContainsForbidden(c, forbidden));
  if (survivors.length < 3) return null;
  const picks = survivors.slice(0, 4);
  const last = picks.pop()!;
  const list = picks.length > 0 ? `${picks.join(', ')}, or ${last}` : last;
  return `A few options: ${list}. ${FOLLOWUP_BY_MEAL[mealType]}`;
}

export function getToolAwareFallback(
  type: MessageType,
  toolResults: ToolResult[],
  opts?: {
    isReasoningRequest?: boolean;
    lastAssistantMessage?: string;
    userMessage?: string;
    dietaryRestriction?: DietaryRestrictionLite | null;
    foodDislikes?: string[];
  },
): string {
  // 2026-06-04 CRITICAL RULE: reasoning requests ("Why?" / "How is that
  // calculated?" / "Where did that come from?") must NEVER fall back to
  // "I'm listening, tell me more" — that violates the launch directive
  // that says Grace must EXPLAIN reasoning when asked, never repeat or
  // deflect. If we got here with isReasoningRequest=true the pipeline
  // failed to generate; use a fallback that at least acknowledges the
  // reasoning request and offers to walk through.
  if (opts?.isReasoningRequest) {
    // If we can reference the prior answer, include it; otherwise stay
    // generic but ACT like Grace is explaining, not deflecting.
    const prior = opts.lastAssistantMessage?.trim().slice(0, 120);
    if (prior && prior.length >= 10) {
      return `That comes from your current weight, goal, and the GLP-1 muscle-preservation math — want me to walk you through the numbers?`;
    }
    return `Good question — that takes a sec to break down. Want the short version or the full math?`;
  }
  // Successfully logged food → reference the actual protein count.
  // Note: outer `r.ok` means the tool didn't throw; the tool's internal
  // logic may still have failed (output.ok === false). Check both.
  const foodLogged = toolResults.find((r) => {
    if (r.name !== 'log_food' || !r.ok || !r.output) return false;
    const out = r.output as Record<string, unknown>;
    return out['ok'] !== false && typeof out['protein_g'] === 'number';
  });
  if (foodLogged) {
    const out = foodLogged.output as Record<string, unknown>;
    const proteinG = Math.round(out['protein_g'] as number);
    const dailyG = typeof out['daily_protein_g'] === 'number' ? Math.round(out['daily_protein_g'] as number) : null;
    // Symptom-aware: if the user mentioned a body symptom alongside the
    // food log, acknowledge the symptom FIRST before reporting the macros.
    // Otherwise the user feels ignored on the medically more important
    // signal. Production failure 2026-06-05: "stomach hurts. I had 2 cups
    // of coffee" → Grace shipped "Logged." silently.
    const hasSymptom = opts?.userMessage ? SYMPTOM_IN_USER_MSG_RE.test(opts.userMessage) : false;
    if (proteinG > 0) {
      const base = dailyG != null && dailyG !== proteinG
        ? `about ${proteinG}g protein for that, you're at ${dailyG}g for today`
        : `about ${proteinG}g protein for that`;
      if (hasSymptom) {
        return `That sounds rough — I hear you. Logged ${base}. Hydration and a small bland snack often help if the discomfort sticks around.`;
      }
      // 2026-06-06: was `Got it — ${base.charAt(0).toUpperCase() + base.slice(1)}.`
      // After format-enforcer's em-dash → comma rule that became "Got it, About
      // 45g protein for that." — a stray capital A mid-sentence. Lowercase
      // version reads correctly both as "Got it — about 45g..." and after
      // conversion to "Got it, about 45g..."
      return `Got it — ${base}.`;
    }
    if (hasSymptom) {
      return "That sounds rough — I hear you. Logged what you mentioned. Hydration and a small bland snack often help if the discomfort sticks around.";
    }
  }

  // Successfully logged weight — brief acknowledgement, no topic switch.
  // Earlier "How are you feeling today?" version scored 0.0 in auto-eval
  // because it always switched topics after the user logged.
  const weightLogged = toolResults.find((r) => r.name === 'log_weight' && r.ok);
  if (weightLogged) return "Tracked.";

  // Successfully logged mood — brief acknowledgement only. The LLM, when
  // working, would have offered something specific; the fallback must not
  // ask a generic follow-up that ignores what the user just shared.
  const moodLogged = toolResults.find((r) => r.name === 'log_mood' && r.ok);
  if (moodLogged) return "I hear you.";

  // Food summary requested — tool returns `protein_g` (today's total)
  const foodSummary = toolResults.find((r) => r.name === 'get_food_summary' && r.ok && r.output);
  if (foodSummary) {
    const out = foodSummary.output as Record<string, unknown>;
    const total = typeof out['protein_g'] === 'number' ? Math.round(out['protein_g'] as number) : null;
    const goal = typeof out['protein_goal_grams'] === 'number' ? Math.round(out['protein_goal_grams'] as number) : null;
    if (total != null) {
      if (goal != null) return `You're at ${total}g protein today — your goal is ${goal}g.`;
      return `You're at ${total}g protein today.`;
    }
  }

  // Food recommendations — search_food_ideas tool returned a list of
  // specific ideas (curated bank or LLM grounded). 2026-06-05 production
  // failure: user asked "What should I eat for breakfast?" → tool ran →
  // returned 4 curated ideas → LLM-formatted response failed a guard →
  // regen also failed → typed fallback shipped "What kind of meal are
  // you thinking, breakfast, lunch, dinner, or a snack?" which echoed
  // back what the user said. Now the fallback ships the actual ideas.
  const foodIdeas = toolResults.find((r) => {
    if (r.name !== 'search_food_ideas' || !r.ok || !r.output) return false;
    const out = r.output as Record<string, unknown>;
    return out['ok'] !== false && Array.isArray(out['ideas']) && (out['ideas'] as unknown[]).length > 0;
  });
  if (foodIdeas) {
    const out = foodIdeas.output as Record<string, unknown>;
    const ideas = out['ideas'] as Array<{ name?: string }>;
    const names = ideas
      .map((i) => (typeof i?.name === 'string' ? i.name.trim() : ''))
      .filter((n) => n.length > 0)
      .slice(0, 4);
    if (names.length >= 2) {
      // Natural comma-list with "or" before the last item.
      const last = names.pop()!;
      const list = names.length > 0 ? `${names.join(', ')}, or ${last}` : last;
      return `A few options: ${list}. Anything sound good?`;
    }
    if (names.length === 1) {
      return `${names[0]} is a solid one — want more options?`;
    }
  }

  // Context-aware food_question fallback. The generic "what kind of meal"
  // typed fallback is tone-deaf when the user asked about protein/calorie
  // targets specifically. Production failure 2026-06-05: "How many proteins
  // should have based on research" → "What kind of meal are you thinking,
  // breakfast, lunch, dinner, or a snack?" — completely off-topic.
  if (type === 'food_question' && opts?.userMessage) {
    const msg = opts.userMessage.toLowerCase();
    if (/\b(protein|calorie|kcal|grams?)\b/.test(msg) && /\b(how (much|many)|target|goal|need|aim|should|recommend)/.test(msg)) {
      return "Research on GLP-1s suggests 1.2-1.6g of protein per kg of body weight daily, with calories supporting a gentle deficit. Want me to estimate yours from your stats?";
    }
  }

  // Context-aware knowledge fallback. The hard-coded knowledge fallbacks
  // are GENERIC GLP-1 facts (muscle loss, mechanism, protein targets).
  // Production failure 2026-06-05: user asked "What is my injection day"
  // → user.injection_day was null → query_fast returned null → classifier
  // picked knowledge → orchestrator failed → shipped the FIRST knowledge
  // fact ("Muscle loss is common on GLP-1s, with research showing 25-35%
  // of weight lost can be lean mass...") — completely unrelated.
  //
  // If the user message is a profile lookup ("what is my X"), don't ship
  // random GLP-1 facts. Redirect to settings, which is honest and useful.
  if (type === 'knowledge' && opts?.userMessage) {
    const msg = opts.userMessage.toLowerCase();
    if (/\bwhat (?:is|'?s)\s+my\b/.test(msg) || /\bdo you know\s+my\b/.test(msg) || /\btell me\s+my\b/.test(msg)) {
      return "I don't have that detail on file yet. You can set it at graceglp.com/settings.";
    }
    // 2026-06-05 production failure: "how much water?" got the muscle-loss
    // typed fallback (first array entry) because the knowledge typed
    // fallbacks are hardcoded muscle-loss / mechanism / protein facts,
    // none of which relate to water. Topic-specific helpful fallbacks
    // for the most common knowledge sub-topics:
    if (/\bwater|hydration|fluid|drink\b/.test(msg) && !/\balcohol|caffeine|coffee\b/.test(msg)) {
      return "Aim for around 64-80 oz of water daily on GLP-1, sipped throughout the day rather than gulped — large amounts at once can amplify nausea.";
    }
    if (/\balcohol\b/.test(msg)) {
      return "Moderation is the general guidance — alcohol can amplify GLP-1 nausea, low blood sugar, and dehydration. A drink or two with food is usually fine for most people, but cut back if you're feeling rough.";
    }
    if (/\bsleep|insomnia|tired|fatigue\b/.test(msg)) {
      return "GLP-1s can disrupt sleep for some people — common causes are nighttime nausea, blood sugar swings, and vivid dreams. A small protein snack 1-2 hours before bed often helps.";
    }
    if (/\bcoffee|caffeine\b/.test(msg)) {
      return "Coffee is generally fine on GLP-1s but can amplify stomach upset, especially on an empty stomach. Try having it with food, or switch to half-caf for a few days if it's hitting hard.";
    }
    if (/\bexercise|workout|gym|cardio|lift|train\b/.test(msg)) {
      return "Resistance training a few times a week is the strongest protector against muscle loss on GLP-1, alongside hitting your protein target. Start light if appetite is suppressed and build up.";
    }
    if (/\bhair\s+(loss|fall|shed|thin)\b/.test(msg)) {
      return "Hair shedding (telogen effluvium) is common with significant weight loss, including GLP-1 weight loss. It's typically temporary — protein, iron, and ferritin levels are worth checking with your doctor if it persists.";
    }
    // 2026-06-05 v4: muscle-specific fallback. Question "How GLP affect my
    // muscles?" was shipping the protein-target typed fallback. Now ships
    // a muscle-preservation-focused answer.
    if (/\bmuscles?\b/.test(msg) && /\b(affect|impact|lose|losing|loss|protect|maintain|keep|preserve|build)\b/.test(msg)) {
      return "GLP-1s don't directly damage muscle, but rapid weight loss without enough protein or resistance training can cost you lean mass — research shows 25-35% of weight lost on GLP-1s can be muscle. Hitting 1.2-1.6g of protein per kg of body weight daily and lifting 2-3x a week shifts the balance toward fat loss.";
    }
    // 2026-06-05 v4: gendered protein-target fallback. "Recommended proteins
    // for a man" / "for a woman" / "for someone my size" was shipping the
    // generic muscle-loss fallback. Now ships a specific protein target.
    if (/\b(protein|grams)\b/.test(msg) && /\b(man|woman|men|women|male|female|guy|girl|someone)\b/.test(msg)) {
      return "On GLP-1 therapy the target is 1.2-1.6g of protein per kg of body weight daily — for an average adult that's roughly 90-130g. Front-load 25-30g at breakfast to protect muscle and reduce muscle loss during weight reduction.";
    }
    // Generic "how much protein" / "protein target" without gender qualifier
    if (/\b(how (much|many)\s+(protein|grams of protein)|protein\s+(target|goal|amount|requirement|need))\b/.test(msg)) {
      return "On a GLP-1 the target is 1.2-1.6g of protein per kg of body weight daily — typically 90-130g for an average adult. Front-load 25-30g at breakfast to protect muscle.";
    }
    // Side-effect duration question
    if (/\b(nausea|side effects?|symptoms?)\b/.test(msg) && /\b(how long|when|going away|stop|end|last|persist)\b/.test(msg)) {
      return "Most GLP-1 side effects peak in the first 4-8 weeks and improve as your body adjusts. If nausea is severe past week 8 or your dose just changed, mention it to your prescriber — they can pause the next escalation.";
    }
    // Plateau / stalled weight
    if (/\bplateau|stall|stuck|not losing|stopped losing\b/.test(msg)) {
      return "Plateaus on GLP-1s are common — your body adapts to the calorie deficit. Things that often break a plateau: making sure you're hitting your protein target, adding resistance training, checking your sleep, and giving your body 2-3 weeks at the same calorie level before adjusting.";
    }
  }

  // 2026-06-06 production failure: "Give me high-protein snacks" classified
  // as 'general' → orchestrator failed → typed fallback rotated to
  // "Say more — I'm with you." A direct request must never become a generic
  // engagement prompt. If the user's message is recommendation-shaped — an
  // imperative ("Give/Show/List me X"), a want statement ("I want X"), or
  // a descriptive food noun ("high-protein snacks") — ship concrete ideas
  // here as a last line of defense, even when classified 'general' or
  // 'food_question'. The classifier fix in classify.ts catches this case
  // upstream; this fallback covers any future near-misses.
  //
  // 2026-06-06 v2: every food suggestion goes through buildDietAwareSuggestion
  // so vegan/vegetarian/pescatarian users + anyone with food dislikes or
  // allergies never sees a forbidden food.
  if ((type === 'general' || type === 'food_question') && opts?.userMessage) {
    const msg = opts.userMessage.toLowerCase();
    const isRecRequest =
      /^(give|show|list|find|suggest|name|tell|share|throw|send|bring|hit)\s+me\b/.test(msg) ||
      /^(?:i\s+)?(want|need|am looking for|looking for|would like|could use)\b/.test(msg) ||
      /\b(high[-\s]protein|low[-\s](?:carb|calorie|fat|sodium|sugar)|protein[-\s]rich|fiber[-\s]rich|plant[-\s]based|keto|vegan|vegetarian|paleo|mediterranean|gluten[-\s]free)\s+(snacks?|meals?|breakfasts?|lunches?|dinners?|foods?|ideas?|options?|recipes?|bars?|drinks?|smoothies?|shakes?)\b/.test(msg) ||
      /\b(snack|meal|breakfast|lunch|dinner|brunch|food|protein|smoothie|shake|recipe|dessert)\s+(ideas?|options?|suggestions?|recommendations?|recipes?)\b/.test(msg);
    if (isRecRequest) {
      const mealType: MealKey =
        /\bbreakfast\b/.test(msg) ? 'breakfast' :
        /\blunch\b/.test(msg) ? 'lunch' :
        /\bdinner\b|supper/.test(msg) ? 'dinner' :
        /\bsnack/.test(msg) ? 'snack' : 'general';
      const suggestion = buildDietAwareSuggestion(mealType, opts.dietaryRestriction, opts.foodDislikes);
      if (suggestion) return suggestion;
      // Not enough diet-safe candidates survived — ask the user to guide
      // instead of risking a forbidden food.
      return "Tell me what usually sits well for you and I'll suggest a few that fit.";
    }
  }

  // 2026-06-06: also intercept the bare-bones TYPED_FALLBACKS.food_question
  // line ("Greek yogurt, cottage cheese, or eggs...") when type is
  // food_question AND no other branch returned. Ship a diet-aware
  // suggestion instead of the hardcoded list.
  if (type === 'food_question' && opts && (opts.dietaryRestriction || (opts.foodDislikes?.length ?? 0) > 0)) {
    const msg = opts.userMessage?.toLowerCase() ?? '';
    const mealType: MealKey =
      /\bbreakfast\b/.test(msg) ? 'breakfast' :
      /\blunch\b/.test(msg) ? 'lunch' :
      /\bdinner\b|supper/.test(msg) ? 'dinner' :
      /\bsnack/.test(msg) ? 'snack' : 'general';
    const suggestion = buildDietAwareSuggestion(mealType, opts.dietaryRestriction, opts.foodDislikes);
    if (suggestion) return suggestion;
  }

  // 2026-06-06 v2 — coverage audit Area 6: Level 2 mood-ladder fallback.
  // Production screenshot 2026-06-06: "want to give up on everything" →
  // "I hear you." (emotional typed fallback). Validates the feeling but
  // doesn't include the Level 2 ladder's "gently suggest professional help"
  // line. When the user message matches Level 2 hopelessness keywords AND
  // we're falling back, ship the ladder-aware reply instead of the bare
  // "I hear you." line — same structure as the Phase 13 prompts.ts rule.
  // No 988 push (no self-harm signaled; safety guard handles those).
  if (type === 'emotional' && opts?.userMessage) {
    const msg = opts.userMessage.toLowerCase();
    const isLevel2 =
      /\b(?:give up on everything|giving up on everything|give up on (?:my )?life|done with everything|over (?:all of )?(?:this|it)|nothing matters|no point|what'?s the point|hopeless|i'?m hopeless|feel(?:ing)? hopeless|no hope|cant shake (?:this|it)|can'?t shake (?:this|it)|so down|really down for (?:a )?while|no motivation for weeks|too tired to (?:keep|even) (?:going|trying)|burnt out completely)\b/.test(msg);
    if (isLevel2) {
      return "I hear how heavy this is. Wanting to give up after pushing hard isn't weakness — it's exhaustion talking. A doctor or therapist can help carry some of this. What feels heaviest right now?";
    }
  }

  return getTypedFallback(type);
}

// ── Topic drift detection — keyword extraction ────────────────────────────
// Extracts content words from messages, filtering out stop words, so we can
// compare what the user is asking about vs. what Grace just answered about.
// Used by buildFocusMarker and the drift/duplication checks in run().
const STOP_WORDS = new Set([
  'i', 'me', 'my', 'you', 'your', 'we', 'our', 'the', 'a', 'an', 'is', 'are',
  'was', 'were', 'am', 'be', 'been', 'do', 'does', 'did', 'has', 'have', 'had',
  'will', 'would', 'could', 'should', 'can', 'may', 'might', 'shall', 'to',
  'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about',
  'it', 'its', 'this', 'that', 'these', 'those', 'and', 'or', 'but', 'if',
  'not', 'no', 'so', 'up', 'out', 'just', 'also', 'than', 'then', 'too',
  'very', 'really', 'how', 'what', 'when', 'where', 'why', 'who', 'which',
  'all', 'any', 'some', 'more', 'most', 'much', 'many', 'well', 'still',
  'tell', 'everything', 'know', 'think', 'like', 'get', 'got',
  'make', 'take', 'going', 'want', 'need', 'hey',
  'hi', 'hello', 'grace', 'thanks', 'thank', 'please', 'ok', 'okay',
  'yes', 'yeah', 'yep', 'nope', 'sure', 'right', 'good', 'great',
  'any', 'question', 'questions',
]);

function extractTopicKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Topic-switch detection. Returns true when the user's CURRENT message is on
 * a different topic than the most recent Grace response.
 *
 * Production failure pattern (2026-06-03 screenshots):
 *   Turn 1: "I'm scared I'm losing muscle" → Grace's long muscle response.
 *   Turn 2: "My hair is falling out, is this from Ozempic?" → Grace
 *           ANSWERED ABOUT MUSCLE LOSS AGAIN.
 *
 * Root cause: Gemini Flash overweights the most-recent assistant turn in
 * history, even when an intervening system message says "TOPIC SWITCH —
 * do NOT continue muscle." Adding warnings is not enough; we have to remove
 * the anchor itself by stripping that prior assistant turn from history
 * before the generation call.
 *
 * Conservative thresholds to avoid false positives on legitimate follow-ups:
 *   • previous Grace message must be substantial (> 100 chars) — short acks
 *     don't anchor strongly so stripping isn't needed
 *   • user message must have ≥ 3 content words — single-keyword "thanks" /
 *     "ok" / "hair?" are too thin to call a topic shift confidently
 *   • keyword overlap with the previous Grace message must be ≤ 1 — at least
 *     one shared word is fine (mentioning the medication, "GLP-1", etc.)
 */
export function detectTopicSwitch(
  userText: string | undefined,
  lastAssistantMessage: string | undefined,
): boolean {
  if (!userText || !lastAssistantMessage) return false;
  if (lastAssistantMessage.trim().length <= 100) return false;
  const userKws = extractTopicKeywords(userText);
  const prevKws = extractTopicKeywords(lastAssistantMessage);
  if (userKws.length < 3) return false;
  if (prevKws.length < 4) return false;
  const overlap = userKws.filter((w) => prevKws.includes(w)).length;
  return overlap <= 1;
}

/**
 * Strip EVERY assistant turn from history. Used when topic-switch is
 * detected — Gemini Flash will anchor on ANY prior Grace turn, not just
 * the most recent one. After a series of muscle / hair / A1C turns, the
 * second-most-recent assistant turn is just as risky an anchor as the
 * last one. User turns stay because they're short, don't anchor strongly,
 * and give the LLM useful arc-of-conversation context.
 */
export function stripAssistantTurns(history: ChatTurn[]): ChatTurn[] {
  return history.filter((t) => t.role !== 'assistant');
}

/**
 * Legacy single-turn strip — kept for tests that explicitly assert it.
 * Production path uses stripAssistantTurns (strips all) because partial
 * stripping leaves earlier anchors intact.
 */
export function stripLastAssistantTurn(history: ChatTurn[]): ChatTurn[] {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'assistant') {
      return [...history.slice(0, i), ...history.slice(i + 1)];
    }
  }
  return [...history];
}

/**
 * Multi-part message detection. When a user message contains multiple
 * distinct asks (coalesced from rapid bursts, or one long message with
 * two questions), Gemini Flash often addresses only the first part and
 * skips the rest. Production failure: "I have no appetite, is that the
 * medication? I forgot my injection yesterday, what should I do?" →
 * Grace answered only about appetite.
 *
 * Heuristic: 2+ question marks OR an explicit conjunction joining two
 * independent clauses. Keep conservative — false positives just add a
 * harmless reminder; false negatives drop a user request entirely.
 */
export function detectMultiPartMessage(userText: string | undefined): boolean {
  if (!userText) return false;
  const trimmed = userText.trim();
  if (trimmed.length < 30) return false;
  // Two or more question marks → almost certainly multiple asks.
  const questionMarks = (trimmed.match(/\?/g) ?? []).length;
  if (questionMarks >= 2) return true;
  // "X. Also Y" / "X. And what about Y" / "X. By the way Y" patterns —
  // two distinct sentences with a continuation cue.
  if (/[.?!]\s+(also|and what about|by the way|another (thing|question)|one more thing|plus|oh and)\b/i.test(trimmed)) {
    return true;
  }
  // 2026-06-05 production failure: "I'm feeling good. But my stomach hurts.
  // I had 2 cups of coffee" — 3 distinct sentences, no '?', no explicit
  // conjunction. Classifier picked food_log, ignored mood + symptom.
  // New rule: 3+ sentences each ≥ 10 chars → multi-part. The user has
  // packed multiple distinct messages into one turn and Grace must
  // address all of them, not just whatever intent the regex matches first.
  const sentences = trimmed
    .split(/[.!?]+\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10);
  if (sentences.length >= 3) return true;
  // 2-sentence case where the two sentences look semantically distinct
  // ("But" / "However" / "And" at the start of the second).
  if (sentences.length === 2) {
    const second = sentences[1]!.toLowerCase();
    if (/^(but|however|though|although|and|also|plus)\b/.test(second)) return true;
  }
  return false;
}

// ── Reasoning-request detection (CRITICAL 2026-06-03 launch rule) ────────
// Production failure: user asks "Why?" / "How did you calculate that?" and
// Grace REPEATS the recommendation instead of EXPLAINING the reasoning.
// This detector + the matching focus-marker banner flip Grace into
// "explain previous response" mode.
//
// Context-aware on purpose: a bare "Why?" with no prior Grace context is
// just an open question. We only fire reasoning-request mode when:
//   • the user message is short (≤ 12 words)
//   • starts with a reasoning trigger (why/how/where/show me/explain)
//   • the prior Grace message contains a number, recommendation verb, or
//     "your X is Y" assertion — i.e. there's something concrete TO explain
const REASONING_TRIGGERS_RE =
  /^\s*(?:and\s+|but\s+|so\s+|wait\s+|ok\s+)?(?:why\??|how\s+(?:do you know|did you (?:calculate|get|arrive|come up|compute|derive|figure)|is that|did that|do you (?:calculate|compute|estimate|figure|figure that))|where (?:did|does) (?:that|this|the) (?:number|figure|come)|can you (?:explain|walk me through|tell me how|show me how|break (?:that|this|it) down)|(?:what'?s|what is) the (?:reasoning|logic|math|calculation|basis|source)|show (?:me )?(?:the|your) (?:math|work|calculation|reasoning)|explain (?:that|this|why|how)|what makes you (?:say|think|recommend)|on what basis|based on what|says? who|where (?:is|are) (?:that|those) from)\b/i;

const PRIOR_REASONING_ANCHOR_RE =
  /\b(?:\d+\s*(?:g|kg|lbs?|kcal|oz|cup|cups|cal|grams?|pounds?|ounces?|hours?|days?|weeks?|months?|years?|%)|recommend|suggest|target|aim for|should|need to|try|here'?s why|because)\b/i;

export function detectReasoningRequest(
  userText: string | undefined,
  lastAssistantMessage: string | undefined,
): boolean {
  if (!userText || !lastAssistantMessage) return false;
  const trimmed = userText.trim();
  if (trimmed.length === 0) return false;
  // Cap word count — long messages with "why" inside are usually new
  // questions ("why am I so tired today?") not reasoning asks.
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 12) return false;
  if (!REASONING_TRIGGERS_RE.test(trimmed)) return false;
  // Context gate: the prior Grace turn must have SOMETHING to explain
  // (a number, a recommendation, a target). Otherwise it's an open Q.
  return PRIOR_REASONING_ANCHOR_RE.test(lastAssistantMessage);
}

// ── Must-acknowledge content (latest-message priority — CRITICAL) ────────
// When the user's latest message reports a symptom, makes a correction,
// or shares a meaningful update, that content MUST be acknowledged
// FIRST regardless of prior conversation flow. The detector returns a
// short tag string ("symptom: headache", "correction", "new info: weight")
// that the focus marker uses to instruct Grace to lead with this content.
// Symptom matchers — case-insensitive regex. Word-boundary anchored so
// short terms ("pain", "rash") don't false-match inside other words.
// Compound terms ("chest pain", "shortness of breath") allow flexible
// whitespace. Hair variants accept "hair is falling out", "hair fell out",
// "losing hair", etc.
const SYMPTOM_RES: Array<{ re: RegExp; label: string }> = [
  { re: /\bheadaches?\b|\bmigraines?\b/i, label: 'headache' },
  { re: /\bnause(?:a|ous)\b|\bqueasy\b|\bvomit(?:ing)?\b|\bthrow(?:ing)?\s+up\b/i, label: 'nausea' },
  { re: /\bdizz(?:y|iness)\b|\blightheaded\b|\bfaint(?:ing)?\b/i, label: 'dizziness' },
  { re: /\bchest\s+pain\b|\bpalpitations?\b|\bshortness\s+of\s+breath\b/i, label: 'chest pain' },
  { re: /\bpain\b|\baching\b|\bcramp(?:s|ing)?\b/i, label: 'pain' },
  { re: /\bdiarrhea\b|\bconstipat(?:ed|ion)\b/i, label: 'GI symptom' },
  { re: /\bbloat(?:ed|ing)\b|\bheartburn\b|\breflux\b|\bindigestion\b|\bburping\b|\bsulfur\b/i, label: 'GI symptom' },
  { re: /\bfatigue\b|\bexhausted\b|\bwiped\b|\bdrained\b/i, label: 'fatigue' },
  { re: /\bshaking\b|\btremors?\b|\bsweating\b|\bchills\b|\bfever\b/i, label: 'systemic symptom' },
  { re: /\brash\b|\bitchy\b|\bswollen\b|\bswelling\b/i, label: 'skin symptom' },
  { re: /\bdepressed\b|\banxious\b|\bpanic\b/i, label: 'mood symptom' },
  // Hair: matches "hair loss", "hair shedding", "hair falling out", "hair is falling", "losing my hair", "hair fell out"
  { re: /\bhair\s+(?:loss|shedding|thinning|fall(?:ing)?|fell|is\s+(?:falling|shedding|thinning))\b|\blosing\s+(?:my\s+)?hair\b/i, label: 'hair loss' },
];

const CORRECTION_PATTERNS_RE =
  /^\s*(?:actually|wait|no wait|sorry|correction|i meant|i mean|let me correct|let me clarify|to clarify|on second thought|scratch that|nevermind|never mind|whoops|my bad|i mistyped|i typed wrong)\b/i;

// New-info: matches dose / medication / weight / med-name changes. Broader
// than the prior version — accepts "I just started 1 mg today", "switched
// to Wegovy", "bumped my dose", etc. Used purely to flag that the latest
// message contains material new context that must be acknowledged.
const NEW_INFO_RE = new RegExp(
  '\\b(?:i\\s+)?(?:just\\s+|now\\s+|finally\\s+|recently\\s+)?' +
  '(?:started|switched|stopped|paused|increased|decreased|lowered|raised|changed|bumped|moved)\\s+' +
  '(?:(?:to|up|down|over)\\s+)?' +
  '(?:my\\s+)?' +
  '(?:dose|doses|medication|meds?|injection|shot|pill|prescription|to\\s+\\d+\\s*(?:mg|mcg)|\\d+\\s*(?:mg|mcg)|' +
  'ozempic|wegovy|mounjaro|zepbound|rybelsus|semaglutide|tirzepatide|saxenda|liraglutide)\\b',
  'i',
);

export interface MustAcknowledge {
  type: 'symptom' | 'correction' | 'new_info';
  label: string;
}

export function detectMustAcknowledge(userText: string | undefined): MustAcknowledge | null {
  if (!userText) return null;
  const trimmed = userText.trim();
  if (trimmed.length === 0) return null;
  if (CORRECTION_PATTERNS_RE.test(trimmed)) {
    return { type: 'correction', label: trimmed.slice(0, 80) };
  }
  if (NEW_INFO_RE.test(trimmed)) {
    return { type: 'new_info', label: trimmed.slice(0, 80) };
  }
  for (const { re, label } of SYMPTOM_RES) {
    if (re.test(trimmed)) {
      return { type: 'symptom', label };
    }
  }
  return null;
}

// Injected right before the user turn to prevent the LLM from anchoring on
// old topics. Quotes the last Grace message so the model knows NOT to repeat it.
function buildFocusMarker(
  type: MessageType,
  toolResults: ToolResult[],
  lastAssistantMessage?: string,
  userText?: string,
  opts?: {
    isTopicSwitch?: boolean;
    isMultiPart?: boolean;
    isReasoningRequest?: boolean;
    mustAcknowledge?: MustAcknowledge | null;
  },
): string {
  const parts: string[] = [];

  // REASONING REQUEST — highest priority: user wants the WHY/HOW behind your
  // previous response, NOT a repeat of the recommendation. Production rule
  // (2026-06-03 CRITICAL): if user asks "why?" / "how did you calculate?",
  // Grace must explain the reasoning, not re-state the answer.
  if (opts?.isReasoningRequest && lastAssistantMessage) {
    const prev = lastAssistantMessage.trim().slice(0, 200).replace(/"/g, "'");
    // Extract specific numbers from the prior response so we can cite them.
    const numbersInPrior = prev.match(/\d+(?:\.\d+)?\s*(?:g|kg|lbs?|kcal|cal|%|min|hrs?|days?|weeks?)/gi) ?? [];
    const numList = numbersInPrior.length > 0 ? ` (specifically: ${numbersInPrior.join(', ')})` : '';
    parts.push(
      `🧠 REASONING REQUEST — THIS IS YOUR #1 PRIORITY INSTRUCTION.\n` +
      `The user is asking you to EXPLAIN your previous response. They want the REASONING, the CALCULATION, or the LOGIC behind it — NOT a repeat, and NOT generic educational content.\n` +
      `Your previous response was: "${prev}"${numList}\n` +
      `2026-06-04 RULE — DO NOT give generic GLP-1 education ("muscle loss happens", "protein is important"). The user already knows that. They want the MATH BEHIND THEIR SPECIFIC NUMBER.\n` +
      `Use the user's actual weight, goal, age, sex from the context block to SHOW THE CALCULATION. E.g. if you recommended 60g protein, the reasoning is something like: "60g ≈ your weight in kg × 1.2g/kg (the GLP-1 muscle-preservation target). At [X]kg, the math gives 60g."\n` +
      `Format: ONE sentence with the actual computation. NO general "GLP-1 medications can sometimes lead to muscle loss" filler — straight to the numbers.`,
    );
  }

  // MUST-ACKNOWLEDGE — user just reported a symptom, a correction, or a
  // material update. That content has to land FIRST in the response,
  // regardless of conversation flow. Production rule: latest message
  // priority. Reported symptoms must never be ignored.
  if (opts?.mustAcknowledge) {
    const ack = opts.mustAcknowledge;
    if (ack.type === 'symptom') {
      parts.push(
        `⚠️ USER REPORTED A SYMPTOM ("${ack.label}") — ACKNOWLEDGE THIS FIRST. Lead the response by addressing the symptom they just reported. Do not bury it behind unrelated content. Empathize briefly, then give specific, GLP-1-aware guidance.`,
      );
    } else if (ack.type === 'correction') {
      parts.push(
        `⚠️ USER IS CORRECTING SOMETHING — ACKNOWLEDGE THE CORRECTION FIRST. Confirm you got the new information, then update your response based on it. Never ignore a correction or continue with stale info.`,
      );
    } else {
      parts.push(
        `⚠️ USER SHARED NEW INFORMATION ("${ack.label}") — ACKNOWLEDGE IT FIRST. The med / dose / weight just changed. Lead with confirming the update, then any follow-up.`,
      );
    }
  }

  // Topic-switch is the highest-priority warning. When the orchestrator's
  // detector fires, the assistant turn has ALREADY been stripped from
  // history — this banner reinforces the strip with an explicit instruction.
  if (opts?.isTopicSwitch && userText && lastAssistantMessage) {
    const userKeywords = extractTopicKeywords(userText);
    const prevKeywords = extractTopicKeywords(lastAssistantMessage);
    const required = userKeywords.slice(0, 6).join(', ');
    const banned = prevKeywords.slice(0, 8).join(', ');
    parts.push(
      `⛔ TOPIC SWITCH DETECTED — THIS IS YOUR #1 PRIORITY INSTRUCTION.\n` +
      `The user has CHANGED the topic. Their NEW message is: "${userText.slice(0, 200)}"\n` +
      `You MUST answer ONLY about: ${required}.\n` +
      `You MUST NOT mention, continue, or reference these words/topics from earlier: ${banned}.\n` +
      `The previous conversation topic is CLOSED. If your response continues the old topic instead of addressing the new one, it will be rejected.`,
    );
  } else if (lastAssistantMessage && lastAssistantMessage.trim().length > 40) {
    // Normal no-repeat guard — Gemini Flash copy-pastes the prev message
    // ~5% of the time. Quoting the first ~100 chars stops the verbatim repeat.
    const snippet = lastAssistantMessage.trim().slice(0, 100).replace(/"/g, "'");
    parts.push(
      `CRITICAL: Your previous message ("${snippet}...") has already been sent and received by the user. Do NOT repeat any part of it. Do NOT start with those words. Write a completely fresh reply to the NEW message below.`,
    );

    // Soft topic-switch warning when the strict orchestrator-level detector
    // didn't fire (e.g. prev message was < 100 chars, but ≥ 2 user keywords
    // and ≤ 1 overlap). Lower-priority than the strict banner above.
    if (userText) {
      const userKeywords = extractTopicKeywords(userText);
      const prevKeywords = extractTopicKeywords(lastAssistantMessage);
      const overlap = userKeywords.filter((w) => prevKeywords.includes(w));
      if (userKeywords.length >= 2 && overlap.length <= 1) {
        const banned = prevKeywords.slice(0, 8).join(', ');
        const required = userKeywords.slice(0, 6).join(', ');
        parts.push(
          `⚠️ TOPIC SWITCH — THIS IS THE #1 PRIORITY INSTRUCTION. The user's NEW message is about a COMPLETELY DIFFERENT topic than your previous response. ` +
          `You MUST answer ONLY about: ${required}. ` +
          `You MUST NOT mention or continue these words/topics from before: ${banned}. ` +
          `The previous conversation topic is CLOSED. If your response contains any of the banned words, it will be rejected and regenerated.`,
        );
      }
    }
  }

  // Multi-part message reminder. When a user sent 2 questions in one turn
  // (often via WhatsApp coalescing of rapid bursts), the LLM tends to drop
  // one. This banner makes it explicit. Production failure: "I have no
  // appetite, is that the medication? I forgot my injection yesterday, what
  // should I do?" → Grace answered only about appetite.
  if (opts?.isMultiPart && userText) {
    parts.push(
      `MULTI-PART MESSAGE — the user asked TWO or more separate things in their message. ` +
      `Address EVERY part. Do not skip any question. Keep each answer short — 1 short sentence per part is fine — but every question gets a direct answer.`,
    );
  }

  // For food-summary queries with a fresh tool result, the answer IS the
  // number — be explicit.
  const foodSummary = toolResults.find((r) => r.name === 'get_food_summary' && r.ok && r.output);
  if (foodSummary) {
    const out = foodSummary.output as Record<string, unknown>;
    const total = typeof out['protein_g'] === 'number' ? Math.round(out['protein_g'] as number) : null;
    const goal = typeof out['protein_goal_grams'] === 'number' ? Math.round(out['protein_goal_grams'] as number) : null;
    if (total != null) {
      parts.push(
        `USER IS ASKING ABOUT TODAY'S PROTEIN TOTAL. Answer with the exact number: ${total}g${goal != null ? ` (goal ${goal}g)` : ''}. One or two short sentences. Do NOT continue any previous topic from history.`,
      );
      return parts.join('\n');
    }
  }

  // Shared HARD RULES applied to EVERY food-related response (regardless of
  // intent classification). 2026-06-04 production wins on food_question
  // recommendations proved these rules work — extracted to apply universally
  // so social_situation eating advice, food_log responses, food-flavored
  // general turns, and emotional+food turns get the same protection.
  const FOOD_RESPONSE_HARD_RULES =
    'HARD RULES (regen-triggering — first attempt MUST follow): ' +
    '(1) NO sycophantic openers ("It\'s wonderful you\'re thinking", "That\'s a great question", "I love that you\'re", "What an amazing choice", "Happy to help", "Since you\'ve...let\'s focus on"). Just answer. ' +
    '(2) MAXIMUM ONE question mark, at the END only. ' +
    '(3) NO list-item format like "Dish Name: description, Other Dish: description" — write dishes in flowing prose, e.g. "Try a lentil soup or a tofu stir-fry — both are quick and satisfying." ' +
    '(4) Keep the WHOLE response to 2-3 short sentences. ' +
    '(5) Respect dietary restrictions ABSOLUTELY (the user\'s dietary_pattern is on the context block — if vegan/vegetarian/pescatarian, NEVER suggest excluded foods). ' +
    '(6) When recommending foods, NAME 2-3 SPECIFIC items (not "lean proteins" or "non-starchy vegetables" — actual dishes / ingredients).';

  const intentDescription: Record<MessageType, string> = {
    food_log: `logging a food they ate. Acknowledge + state the protein from the tool result. Do NOT continue any previous topic. ${FOOD_RESPONSE_HARD_RULES}`,
    food_question: `asking a question about food or nutrition. Answer their question directly. Do NOT continue any previous topic. ${FOOD_RESPONSE_HARD_RULES}`,
    weight_log: 'reporting their weight. Acknowledge + respond warmly. Do NOT continue any previous topic.',
    mood_log: 'sharing their mood or energy level. Respond with empathy. Do NOT continue any previous topic.',
    greeting: 'just greeting you. Reply with ONE warm sentence. Topic reset — do NOT reference any prior conversation.',
    emotional: 'sharing a feeling or struggle. Validate first. Do NOT continue any previous topic.',
    scheduling: 'asking about message frequency. Do NOT continue any previous topic.',
    knowledge: 'asking a GLP-1 / medication / nutrition knowledge question. Answer directly with facts. Do NOT continue any previous topic.',
    appointment_prep: 'asking for help preparing for a doctor / endocrinologist / specialist appointment. Draft 4-6 SPECIFIC questions for them to bring, using their conversation context (current side effects, protein struggles, dose, journey stage). DO NOT respond with "What\'s on your mind?" — they told you what\'s on their mind: the appointment. Provide questions immediately. Write as flowing prose (no bullets / numbers / headers).',
    gibberish: 'sending an unclear message. Ask a brief clarifying question.',
    general: 'sending a new message. Answer ONLY what they just asked. Do NOT continue any previous topic. Do NOT repeat or paraphrase any previous Grace message.',
    // Phase 1 coverage expansion intents
    exercise_log: 'reporting a workout / walk / cardio session. Briefly acknowledge + tie to muscle preservation or protein within 1-2 hours. Do NOT continue any previous topic. Do NOT estimate calories burned.',
    injection_log: 'confirming they took their weekly shot (or daily pill). Short warm acknowledgment + a single practical tip (hydration / protein first / nausea timing). Do NOT lecture. Do NOT continue any previous topic.',
    medication_question: 'asking a medication-specific question: dose timing, storage, travel, refill, switching, injection site. Answer with facts. For dose-change asks, use the warm clinical-redirect template ("That one I\'d genuinely leave to your doctor..."). Do NOT use alarmist language.',
    // Social situations are mostly about food strategies → inherit food rules
    social_situation: `asking about restaurants, parties, travel meals, weddings, holidays, or family pressure around eating. Be practical (1-2 actionable strategies) and warm — never shaming. No restrictive language. Acknowledge the social dimension. ${FOOD_RESPONSE_HARD_RULES}`,
    pause_request: 'asking to pause messages / take a break. Confirm in ONE warm sentence + tell them they can text you anytime to resume. Do NOT ask why. Do NOT try to keep them engaged.',
  };

  parts.push(`[CURRENT USER MESSAGE TYPE: ${intentDescription[type]}]`);

  // 2026-06-04: detect food keywords in the CURRENT message AND inject food
  // HARD RULES if the intent didn't already (e.g. a 'general' or 'emotional'
  // turn that mentions food). Catches misclassified food asks like
  // "I'm hungry, what should I have?" / "any snack ideas?" that fall outside
  // food_question for some reason.
  const intentsWithFoodRules = new Set(['food_log', 'food_question', 'social_situation']);
  if (
    !intentsWithFoodRules.has(type) &&
    userText &&
    /\b(eat|breakfast|lunch|dinner|snack|meal|hungry|appetite|food|recipe|cook|order|grab|protein|carb|calories?)\b/i.test(userText)
  ) {
    parts.push(`[FOOD CONTEXT DETECTED] ${FOOD_RESPONSE_HARD_RULES}`);
  }

  if (userText && userText.length > 3 && type !== 'greeting' && type !== 'gibberish') {
    const echo = userText.trim().slice(0, 150).replace(/"/g, "'");
    // 2026-06-04 production failure: Grace replied to "What should I eat for
    // breakfast?" with meta-commentary about why she'd ask "why" — even
    // referencing the user's earlier "Why?" turn. Strengthened banner:
    //   - LAST line of the message defines the priority topic
    //   - Forbid meta-commentary about what Grace would ask back
    //   - Forbid hypothetical "if you asked a friend" framing
    //   - Forbid "I'm asking why because" preambles
    parts.push(
      `>>> THE USER'S CURRENT MESSAGE: "${echo}" <<<\n` +
      `Your ENTIRE response must answer THIS message. Not the previous one. Not something from history. THIS one above.\n` +
      `If the message has multiple parts, the LAST sentence/question defines the priority — answer that first, then optionally the earlier parts in one or two sentences.\n` +
      `BANNED — these are meta-commentary, not answers:\n` +
      `  ✗ "I'm asking why because I need more information..."\n` +
      `  ✗ "Think of it this way if you asked a friend..."\n` +
      `  ✗ "Here's why I need more info and what kind of things would be helpful..."\n` +
      `  ✗ "Let me explain why I'm asking..."\n` +
      `Either ANSWER with what you have, or ask ONE concrete clarifying question. Never both. Never explain WHY you'd ask.`,
    );
  }

  return parts.join('\n');
}

// Only run the LLM critic for genuinely dangerous intent categories.
// `knowledge_lookup` was here but it's too broad — food/nutrition questions
// get treated as risky and the critic then fails on USDA protein-gram facts
// that aren't verbatim in retrieved KB chunks. The validator's
// `possible_medical_advice` flag handles the cases we care about.
const RISKY_INTENT_PREFIXES = ['safety_'];

// The orchestrator composes three sub-components: PlannerAgent (decides which
// tools to call), LLMCritic (grades response safety/grounding), and
// RelevanceChecker (verifies the response answers the user's actual question).
export class AIOrchestrator {
  private planner: PlannerAgent;
  private critic: LLMCritic;
  private relevance: RelevanceChecker;
  private behavioral: BehavioralGuard;

  constructor(private deps: OrchestratorDeps) {
    this.planner = deps.planner ?? new PlannerAgent(deps.llm);
    this.critic = deps.critic ?? new LLMCritic(deps.llm);
    this.relevance = new RelevanceChecker(deps.llm);
    this.behavioral = new BehavioralGuard(deps.llm);
  }

  // Main pipeline. Steps: (1) classify message type, (2) plan + execute tools,
  // (3) generate LLM response, (4) enforce format, (5) check content rules
  // (block/regen/log), (6) check grounding + topic drift + relevance,
  // (7) regen if any check fails, (8) web search fallback, (9) safe fallback.
  async run(input: OrchestratorInput): Promise<OrchestratorOutput> {
    const started = Date.now();

    // Step 1: Fast deterministic classifier — drives typed fallbacks, planner skip, and thinking control.
    const classification = classifyMessage(input.text);
    const simpleTypes = ['greeting', 'gibberish', 'food_log', 'weight_log', 'mood_log'];
    const skipPlanner = simpleTypes.includes(classification.type);
    // 2026-06-03 latency emergency: production telemetry showed orchestrator
    // taking 20-27s per message because thinking was enabled by default for
    // any intent NOT in this list. Inverting the gate: thinking is OFF by
    // default, ON only for intents that genuinely need chain-of-thought
    // (drug-interaction safety, medication dose/timing, doctor appointment
    // prep, GLP-1 mechanism questions). Everything else — food logs, weight
    // logs, food recommendations, emotional support, social situations —
    // generates faster without thinking and the quality is equivalent.
    const NEEDS_THINKING = new Set(['knowledge', 'medication_question', 'appointment_prep']);
    const isSimpleMessage = !NEEDS_THINKING.has(classification.type);

    // 2026-06-03 hotfix: Google deprecated gemini-2.0-flash entirely. Every
    // non-knowledge LLM call was hitting 404 and falling into the bare-bones
    // emergency-fallback path (no dietary filter, no format enforcer, no
    // content rules). Switched to gemini-2.5-flash-lite — Google's current
    // fastest model in the 2.5 family, supports disableThinking, ~50% faster
    // than gemini-2.5-flash on simple intents.
    //
    // Safety net: if Google deprecates this too, the 404 → fallback chain in
    // GeminiProvider (isTransientGeminiError now matches 404) will route the
    // call to env.GEMINI_FALLBACK_MODEL (= gemini-2.5-flash, known-working).
    // No more emergency-fallback path on model deprecations.
    const fastModel = 'gemini-2.5-flash-lite';
    const generateModel: string | undefined = isSimpleMessage ? fastModel : undefined;

    const chatFallbackPlan: PlannerDecision = { intent: 'chat', needsTools: false, toolCalls: [], rationale: 'tools_disabled' };
    // If the caller ran the planner in parallel with RAG (ai.service.ts does
    // this for latency), use that result directly. Otherwise plan now.
    const plan: PlannerDecision = input.prePlannedDecision
      ? input.prePlannedDecision
      : (input.toolsEnabled && !skipPlanner)
        ? await this.planner.plan(input.text).catch(() => chatFallbackPlan)
        : chatFallbackPlan;

    let toolResults: ToolResult[] = [];
    let toolsMs = 0;
    if (plan.needsTools && plan.toolCalls.length > 0) {
      const toolsStart = Date.now();
      toolResults = await this.deps.tools.executeMany(plan.toolCalls);
      toolsMs = Date.now() - toolsStart;
    }

    // Long-term semantic memories about this user — top-k retrieved by
    // ai.service.ts from the user_memories table. Framed as background-only
    // so the LLM doesn't randomly surface unrelated facts.
    const memoryBlock = input.userMemories && input.userMemories.length > 0
      ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nBACKGROUND MEMORY (DO NOT mention unless directly relevant to the user's CURRENT message):\n${input.userMemories.map((m) => `- ${m}`).join('\n')}\nIMPORTANT: These are background facts. Only reference a fact if the user's current message is about that specific topic. Never volunteer unrelated memories.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      : '';

    const toolResultBlock = toolResults.length > 0
      ? `\n\nTool results (use ONLY to answer the user's current question — do not mention tool data that isn't relevant to what they just asked):\n${JSON.stringify(toolResults)}`
      : '';

    const baseSystem =
      (input.systemPrompt ?? GRACE_SYSTEM_PROMPT) +
      memoryBlock +
      renderRetrievalContext(input.retrieved) +
      toolResultBlock;

    // Extract the last Grace message from history — used in the focus marker
    // and in the format-enforcer deduplication check.
    const lastAssistantMessage = [...input.history]
      .reverse()
      .find((m) => m.role === 'assistant')?.content ?? undefined;

    // ── Context-isolation defenses (2026-06-03 production failures) ─────
    // Two independent failure modes from the screenshots:
    //
    //   (1) TOPIC SWITCH: user says "hair?" after a muscle answer; Gemini
    //       Flash anchors on the most-recent assistant turn(s) and keeps
    //       producing muscle content. Fix: detect the switch and strip
    //       EVERY assistant turn from history — there's nothing left to
    //       anchor on. User turns stay (short, low-anchor, useful context).
    //
    //   (2) MULTI-PART MESSAGE: coalesced WhatsApp burst contains two
    //       independent asks; Gemini answers only the first. Fix: detect
    //       2+ '?' or continuation cues and instruct the model explicitly
    //       to address every part.
    const isTopicSwitch = detectTopicSwitch(input.text, lastAssistantMessage);
    const isMultiPart = detectMultiPartMessage(input.text);
    // Reasoning-request detection — "why?" / "how did you calculate?"
    // After previous Grace response containing numbers / recommendations.
    // When this fires, the focus marker tells Grace to EXPLAIN the prior
    // reasoning instead of repeating the recommendation. Production rule
    // (2026-06-03 CRITICAL): never re-state when user asks why.
    const isReasoningRequest = detectReasoningRequest(input.text, lastAssistantMessage);
    // Must-acknowledge detection — symptom / correction / new-info that
    // has to land FIRST in the response regardless of conversation flow.
    const mustAcknowledge = detectMustAcknowledge(input.text);

    const generationHistory: ChatTurn[] = isTopicSwitch
      ? stripAssistantTurns([...input.history])
      : [...input.history];

    // Topic-focus injection. Always inject a focus marker right before the
    // user turn. It (1) tells Gemini what kind of message this is, (2)
    // explicitly quotes the last Grace message so the model knows NOT to
    // repeat it verbatim, and (3) on detected topic-switch / multi-part /
    // reasoning-request / must-acknowledge, emits the strongest banner.
    const focusMarker = buildFocusMarker(
      classification.type,
      toolResults,
      lastAssistantMessage,
      input.text,
      { isTopicSwitch, isMultiPart, isReasoningRequest, mustAcknowledge },
    );

    const generationMessages = [
      { role: 'system' as const, content: baseSystem },
      ...renderHistory(generationHistory),
      { role: 'system' as const, content: focusMarker },
      { role: 'user' as const, content: input.text },
    ];

    // Per-intent token budget (2026-05-30 latency pass) — tighter caps shave
    // ~200-400ms off generation latency without compromising completeness.
    // Gemini 2.5 Flash allocates thinking tokens from maxOutputTokens, so the
    // numbers below include both thinking + output budget. Simple intents
    // disable thinking entirely (disableThinking: true) so the full budget
    // goes to the response.
    let generationTokenBudget: number;
    if (classification.type === 'greeting' || classification.type === 'gibberish') {
      generationTokenBudget = 256; // one-sentence reply, thinking off
    } else if (classification.type === 'food_log' || classification.type === 'mood_log') {
      generationTokenBudget = 512; // log ack + macro number, thinking off
    } else if (classification.type === 'weight_log') {
      // Bumped 512 → 1024 (2026-06-03): compound weight-log messages
      // ("I weigh 184 and what should I eat?") were truncating at 512 and
      // forcing a 5s regen. 1024 covers the ack + a brief food suggestion
      // without truncation, eliminating the regen entirely.
      generationTokenBudget = 1024;
    } else if (classification.type === 'emotional') {
      generationTokenBudget = 1024; // 2-sentence empathic reply, thinking off
    } else if (classification.type === 'food_question') {
      // 2026-06-03 cascade fix: was 8192 (catch-all). Production telemetry
      // showed every food_question over-generating, hitting the 8192 cap,
      // truncating mid-sentence, then triggering a 6+ second cascade:
      //   regen (LLM #2) → retry-critic (LLM #3) → web-search-fallback
      //   (LLM #4 with Google Search grounding). Total ~10s of wasted work.
      // A food recommendation response is 2-3 sentences (~150 tokens), so
      // 1024 leaves comfortable headroom. Truncation eliminated → entire
      // cascade eliminated.
      generationTokenBudget = 1024;
    } else if (classification.type === 'general' || classification.type === 'social_situation' ||
               classification.type === 'scheduling' || classification.type === 'pause_request' ||
               classification.type === 'exercise_log' || classification.type === 'injection_log') {
      // Conversational chat — 2-4 sentences. Same truncation-prevention logic
      // as food_question; previously fell into the 8192 catch-all.
      generationTokenBudget = 1024;
    } else if (classification.type === 'appointment_prep') {
      // 4-6 specific questions in flowing prose. quality-guard caps at 800
      // chars (~200 tokens). 2026-06-04 latency cut: production telemetry
      // showed appointment_prep generates taking 11s with 2048 budget and
      // thinking enabled — way over-provisioned for a 5-sentence answer.
      // Cut to 1024 (~700 thinking + 300 output), still comfortable headroom.
      generationTokenBudget = 1024;
    } else if (classification.type === 'knowledge') {
      // GLP-1 mechanism / side-effect explanations. quality-guard caps at
      // 600 chars (~150 tokens output). 2026-06-04 latency cut: production
      // telemetry showed knowledge generates p95=12520ms with budget 2048,
      // even though screenshots show 3-4 sentence answers. The 2048 budget
      // was funding thinking tokens that weren't producing better answers.
      // 1024 = ~700 thinking + 300 output, more than enough for any answer
      // the quality-guard would let through.
      generationTokenBudget = 1024;
    } else if (classification.type === 'medication_question') {
      // Dose timing / storage / travel-with-pen — short fact-based answers
      // that quality-guard caps at the 350-char default (~90 tokens).
      // 1024 = ~700 thinking + 300 output with thinking enabled.
      generationTokenBudget = 1024;
    } else {
      // Defensive default — if a new intent type is added without an
      // explicit budget, use a conservative 1024 instead of 8192 to keep
      // the truncation-cascade risk bounded.
      generationTokenBudget = 1024;
    }

    let regenMs = 0;
    const generateStart = Date.now();
    // 2026-06-04: per-intent temperature. Lower temperature = less creative
    // output = fewer banned-phrase / list-format slips. Knowledge and
    // medication intents need especially constrained outputs (factual,
    // boring, no flourish). food_log / weight_log are deterministic
    // confirmations — minimal temperature. Emotional and conversational
    // intents keep modest temperature for warmth.
    const HIGH_PRECISION_INTENTS = new Set([
      'knowledge', 'medication_question', 'food_log', 'weight_log',
      'mood_log', 'exercise_log', 'injection_log',
    ]);
    const generationTemperature = HIGH_PRECISION_INTENTS.has(classification.type)
      ? 0.25
      : 0.5; // was 0.6 across the board; lowered to 0.5 to reduce stylistic drift
    const llmResp = await this.deps.llm.generate({
      messages: generationMessages,
      temperature: generationTemperature,
      maxOutputTokens: generationTokenBudget,
      disableThinking: isSimpleMessage,
      ...(generateModel ? { model: generateModel } : {}),
    });
    const generateMs = Date.now() - generateStart;
    const postgenStart = Date.now();

    // ─── Format enforcement (silent auto-fix) ─────────────────────────
    // Strip em dashes, markdown bold, numbered lists, etc. that Gemini Flash
    // emits despite the system prompt's "BANNED" rules. This always runs and
    // never triggers a regen — it's just a deterministic cleanup pass.
    // The user's first name is also stripped here on non-welcome turns
    // (NAME USAGE ZERO TOLERANCE).
    const stripName = !input.isFirstMessage && input.userFirstName ? input.userFirstName : undefined;
    const enforceOpts = {
      ...(stripName ? { stripFirstName: stripName } : {}),
      messageContext: classification.type,
      // Pass last Grace message so enforceFormat can strip any duplicate prefix.
      // Gemini Flash sometimes copy-pastes the previous response before appending
      // new content. The deduplication check catches this silently.
      ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
      // Pass user's message so enforceFormat can strip verbatim parroting.
      // E.g. "I ate two eggs" → Grace must NOT open with "I ate two eggs is about..."
      ...(input.text ? { userMessage: input.text } : {}),
    };
    const formatted = enforceFormat(llmResp.text, enforceOpts);
    let validated = validateResponse(formatted.text);
    const precheck = precheckGrounding(validated.text, input.retrieved);
    let critic: CriticReport | undefined;
    let regenerated = false;
    let usedSafeFallback = false;

    // ─── Step 5: Content-rule enforcement ──────────────────────────────
    // Three severity levels: block (never send, immediate safe fallback),
    // regen (LLM must rewrite), log (telemetry only, response still sent).
    // Stale-context-echo whitelist (last layer per user directive 2026-06-01):
    //   - systemContext: the full system prompt this turn was built with.
    //     Includes the THIS USER'S DATA block with today's protein/calorie
    //     totals, weight, etc. Any number Grace references should appear here
    //     (or in the user message or tool results).
    //   - toolResultsText: stringified tool outputs from this turn. Lets
    //     Grace use fresh numbers from log_food / get_food_summary calls
    //     without triggering the stale-echo guard.
    const toolResultsText = toolResults
      .map((r) => {
        if (r.output === null || r.output === undefined) return '';
        if (typeof r.output === 'string') return r.output;
        try { return JSON.stringify(r.output); } catch { return ''; }
      })
      .join(' ');
    // Extract the prior user message (one before the current) for the
    // re-litigation check. Used to detect when Grace's response addresses
    // sub-topics from the PRIOR user message instead of the current one
    // (e.g. "Anytime" / "Glad to hear you slept well" after the user has
    // moved on to a different topic).
    const priorUserMessage = [...input.history]
      .reverse()
      .find((m) => m.role === 'user')?.content;
    const contentCheckOpts = {
      ...(input.dietaryRestriction ? { dietaryRestriction: input.dietaryRestriction } : {}),
      ...(input.foodDislikes && input.foodDislikes.length > 0 ? { foodDislikes: input.foodDislikes } : {}),
      ...(input.medicationType ? { medicationType: input.medicationType } : {}),
      ...(input.responseMode ? { responseMode: input.responseMode } : {}),
      ...(input.dbRules && input.dbRules.length > 0 ? { dbRules: input.dbRules } : {}),
      userMessage: input.text,
      ...(priorUserMessage ? { previousUserMessage: priorUserMessage } : {}),
      intentType: classification.type,
      systemContext: baseSystem,
      toolResultsText,
    };
    const contentViolations: ContentViolation[] = checkContent(validated.text, contentCheckOpts);

    // ── Block-severity gate ───────────────────────────────────────────────────
    // Block rules (e.g. extra-dose commands, prescribing language) must never
    // reach the user even after a regen — skip straight to safe fallback so
    // no extra Gemini call is made.
    const blockViolations = contentViolations.filter((v) => v.severity === 'block');
    if (blockViolations.length > 0) {
      return {
        text: getToolAwareFallback(classification.type, toolResults, { isReasoningRequest, ...(lastAssistantMessage ? { lastAssistantMessage } : {}), ...(input.text ? { userMessage: input.text } : {}), ...(input.dietaryRestriction ? { dietaryRestriction: input.dietaryRestriction } : {}), ...(input.foodDislikes && input.foodDislikes.length > 0 ? { foodDislikes: input.foodDislikes } : {}) }),
        confidence: 'low',
        intent: plan.intent,
        toolResults,
        usedRetrieval: input.retrieved.length > 0,
        latencyMs: Date.now() - started,
        internalTimings: { tools: toolsMs, generate: generateMs, postgen: Date.now() - postgenStart, guards: 0, review: 0, regen: 0, thinkingDisabled: isSimpleMessage },
        usedSafeFallback: true,
        critic: {
          scores: { grounding: 1, safety: 1, on_task: 1, tone: 1 },
          overall: 4,
          pass: false,
          issues: blockViolations.map((v) => v.message),
          source: 'precheck',
        },
      };
    }

    // ── Truncation detection (session-3 feedback) ─────────────────────────
    // Format-enforcer flags `truncation_suspected` when the response ends
    // without sentence-final punctuation — typically a knowledge/medical
    // answer that hit max_tokens mid-list. Inject as a regen violation so
    // the retry path bumps the token budget + appends the truncation-recovery
    // instruction.
    if (formatted.fixes.includes('truncation_suspected')) {
      contentViolations.push({
        code: 'truncation_suspected',
        message: 'Response appears to end mid-sentence (no terminal punctuation). REWRITE in 2-3 short sentences as continuous prose — no lists, no numbered breakdowns, no headers. Ensure a complete sentence ending.',
        severity: 'regen',
      });
    }

    // Only regen/undefined violations trigger regeneration; log violations are
    // surfaced in telemetry but don't affect the response.
    const regenViolations = contentViolations.filter(
      (v) => !v.severity || v.severity === 'regen',
    );

    // ── Step 6: Response relevance + duplication checks ─────────────────
    // Three layers: (a) keyword overlap ratio detects obvious topic drift,
    // (b) Jaccard similarity detects copy-paste duplication of last response,
    // (c) LLM relevance check catches semantic mismatches keywords miss.
    //
    // 2026-06-03 latency cut: the keyword-based heuristic (a) was a FALSE
    // POSITIVE machine for intents that naturally reference prior context.
    // Production telemetry:
    //   user: "what should I eat for dinner?"
    //   resp: "You've already hit your 60g protein target today, so dinner..."
    //   keyword check: response matches "protein"/"target"/"today" from the
    //   previous Grace message → drift detected → 2s regen → SAME content.
    // The LLM relevance check (layer c) catches the genuinely-bad cases the
    // keyword check is trying to catch, without the false positives.
    const KEYWORD_DRIFT_SKIP_INTENTS = new Set([
      'food_question',  // references today's protein/calorie context
      'food_log',       // ack uses prior food/macro context
      'weight_log',     // ack references previous weight
      'mood_log',
      'general',        // catch-all; LLM relevance handles it
    ]);
    const skipKeywordDrift = KEYWORD_DRIFT_SKIP_INTENTS.has(classification.type);

    let topicDrift = false;
    if (!skipKeywordDrift && lastAssistantMessage && lastAssistantMessage.trim().length > 40 && classification.type !== 'greeting') {
      const userKws = extractTopicKeywords(input.text);
      const prevKws = extractTopicKeywords(lastAssistantMessage);
      const respKws = extractTopicKeywords(validated.text);

      // Check 1: topic drift — response matches old topic, misses new one.
      // Triggers when the response is more aligned with the previous assistant
      // message than with the user's current message. A ratio-based check catches
      // cases where one incidental word overlaps with the user but 3+ words
      // match the old topic.
      if (userKws.length >= 2) {
        const respMatchesUser = userKws.filter((w) => respKws.includes(w)).length;
        const respMatchesPrev = prevKws.filter((w) => respKws.includes(w)).length;
        const drifted =
          (respMatchesUser === 0 && respMatchesPrev >= 2) ||
          (respMatchesPrev >= 3 && respMatchesPrev > respMatchesUser * 2);
        if (drifted) {
          topicDrift = true;
          regenViolations.push({
            code: 'topic_drift',
            message: `Response is about the PREVIOUS topic (shares ${respMatchesPrev} keywords with last response, only ${respMatchesUser} with user's new message). Answer the user's CURRENT message instead: "${input.text.slice(0, 100)}"`,
            severity: 'regen',
          });
        }
      }

      // Check 2: response duplication — response is a rephrased copy of last
      // Grace message. Jaccard similarity on content words > 0.5 = too similar.
      if (!topicDrift && prevKws.length >= 3 && respKws.length >= 3) {
        const union = new Set([...prevKws, ...respKws]);
        const intersection = prevKws.filter((w) => respKws.includes(w)).length;
        const jaccard = intersection / union.size;
        if (jaccard > 0.4) {
          topicDrift = true;
          regenViolations.push({
            code: 'response_duplication',
            message: `Response is too similar to your previous message (${Math.round(jaccard * 100)}% keyword overlap). Write a COMPLETELY DIFFERENT response. Do not rephrase the same information.`,
            severity: 'regen',
          });
        }
      }
    }

    // Detect mid-word/mid-sentence truncation (e.g. "...easy-to-" cut off by
    // hitting maxOutputTokens). Forces the critic→regen path so the user
    // never sees a half-sentence reply. Three signals — any one triggers:
    //   1. finishReason === 'length' (Gemini ran out of budget)
    //   2. endsMidWord (last token is mid-word — heuristic)
    //   3. formatted.fixes includes 'truncation_suspected' (no terminal
    //      punctuation after list-intro stripping — session-3 failure mode)
    const truncated =
      llmResp.finishReason === 'length' ||
      endsMidWord(validated.text) ||
      formatted.fixes.includes('truncation_suspected');

    // ─── Final quality guard (deterministic, last check before send) ──────
    // Catches walls of text, nutrition-report formatting, numeric clutter,
    // and excessive questions that slip past content rules and the LLM
    // relevance check. Failures trigger regen with specific feedback.
    //
    // 2026-06-04: gated on guards.qualityStrict (default true). When false
    // OR when trustGemini is on, we skip the sentence/length cap regens that
    // produced the "knowledge answer chopped to 2 sentences" failures and
    // trust Gemini to format the response. Cosmetic issues (em-dashes,
    // markdown, headers) are still cleaned by format-enforcer below.
    const trustGeminiMode = this.deps.guards?.trustGemini === true;
    const qualityStrictFlag = this.deps.guards?.qualityStrict !== false;
    const qualityGuardActive = !trustGeminiMode && qualityStrictFlag;
    const qualityIssue = qualityGuardActive
      ? checkResponseQuality(validated.text, classification.type)
      : null;
    if (qualityIssue) {
      regenViolations.push({
        code: qualityIssue.code,
        message: qualityIssue.message,
        severity: 'regen',
      });
    }

    // ─── Parallel LLM guards (relevance + behavioral + critic) ───────────
    // Latency optimization (2026-05-30): the three LLM-based post-generation
    // guards are independent — they all judge the same response — so we run
    // them concurrently with Promise.all instead of sequentially. Saves
    // ~500-800ms per turn on average.
    //
    // Skip rules (zero-risk cases — no LLM call needed):
    //   - Greeting / gibberish / brief reply: response is too short and the
    //     deterministic content checker already covers it.
    //   - Very short responses (<40 chars): one-sentence acks like "Got it 👍"
    //     have no surface area for behavioral/relevance failures.
    //   - Topic drift OR existing regen violation already triggered: we'll
    //     regen anyway, so spending more LLM calls is wasted work.
    const looksLikeQuestion =
      /\?/.test(input.text) ||
      /\b(how|what|why|when|where|am i|are you|can i|should i|is it|do you|does this|but i|but my)\b/i.test(input.text);
    const isTrivial =
      classification.type === 'greeting' ||
      classification.type === 'gibberish' ||
      validated.text.length < 40;
    // 2026-06-04 latency cut: skip relevance check for food intents. The
    // response is constrained by the dietary filter + food rules to be about
    // food; the relevance check was producing false positives (telemetry
    // showed a clearly-on-topic dinner response flagged "not relevant",
    // triggering a 4.5s regen + needsReview cascade). Saves ~700ms per
    // food_question / food_log turn. Knowledge / medication / general intents
    // still get relevance checked because they genuinely can drift.
    const RELEVANCE_SKIP_INTENTS = new Set([
      'food_log',
      'food_question',
      'weight_log',
      'mood_log',
      'exercise_log',
      'injection_log',
    ]);
    // Intents where the relevance check ALWAYS runs, even in TRUST_GEMINI
    // mode. These are factual / medical question types where the cost of
    // off-topic or cross-talk responses outweighs the ~700ms judge latency.
    // Production failure 2026-06-04: with TRUST_GEMINI on, user asked "can
    // I have coffee?" then "is hair loss normal?" — Grace answered BOTH
    // (joining "Yes, you can have coffee. Regarding hair loss...") AND
    // asked "What kind of injections are you referring to?" (deflection
    // despite knowing the user's medication). The relevance check would
    // have caught the off-topic re-answer and forced a regen on the
    // current message only.
    const CRITICAL_RELEVANCE_INTENTS = new Set([
      'knowledge',
      'medication_question',
      'appointment_prep',
    ]);
    // 2026-06-04 TRUST GEMINI gates. When trustGeminiMode=true, all three
    // LLM-as-judge guards are skipped — Gemini's natural output ships
    // unless safety / format / harmful-content checks flag it. This is the
    // lean pipeline. (trustGeminiMode was already computed above for the
    // quality-guard gate.)
    const behavioralFlagOn = this.deps.guards?.behavioralEnabled !== false; // default true
    const relevanceFlagOn = this.deps.guards?.relevanceEnabled !== false;
    // Critical intents (knowledge/medication/appointment_prep) get the
    // relevance check EVEN in trustGeminiMode — they have the highest cost
    // of cross-talk or off-topic answers. Other intents follow the
    // trustGeminiMode rule.
    const intentForcesRelevance = CRITICAL_RELEVANCE_INTENTS.has(classification.type);
    const shouldRunRelevance =
      (intentForcesRelevance || !trustGeminiMode) &&
      relevanceFlagOn &&
      !isTrivial &&
      !topicDrift &&
      !RELEVANCE_SKIP_INTENTS.has(classification.type) &&
      (lastAssistantMessage || looksLikeQuestion) &&
      input.text.length > 10;
    const shouldRunBehavioral =
      !trustGeminiMode &&
      behavioralFlagOn &&
      !isTrivial && !topicDrift && regenViolations.length === 0;
    // Run the critic in this parallel batch only when the intent is risky
    // (it'll be needed regardless of other guards). Non-risky critic invocations
    // happen later via review() inside the needsReview branch.
    // Note: critic is NOT bypassed by trustGemini — risky intents (safety_*)
    // still get adjudicated because that's a hard safety requirement.
    const shouldRunCriticEarly =
      !isTrivial && this.shouldRunCritic(plan, validated);

    const userContextBlock = shouldRunBehavioral && baseSystem.includes('━━━ THIS USER')
      ? baseSystem.slice(baseSystem.indexOf('━━━ THIS USER'), baseSystem.indexOf('━━━ END OF USER DATA ━━━') + 24)
      : '';

    const postgenMs = Date.now() - postgenStart;
    const guardsStart = Date.now();
    // Per-guard timing — when orch_guards is hot, we need to know WHICH of the
    // three is bounding the parallel wait. Wrap each promise so we capture
    // its individual duration before Promise.all resolves.
    let relevanceGuardMs = 0;
    let behavioralGuardMs = 0;
    let criticGuardMs = 0;
    const timeGuard = <T>(p: Promise<T>, set: (ms: number) => void): Promise<T> => {
      const start = Date.now();
      return p.then(
        (v) => { set(Date.now() - start); return v; },
        (e) => { set(Date.now() - start); throw e; },
      );
    };
    const [relevanceVerdict, behavioralViolations, earlyCritic] = await Promise.all([
      shouldRunRelevance
        ? timeGuard(this.relevance.check(input.text, validated.text, lastAssistantMessage), (ms) => { relevanceGuardMs = ms; })
        : Promise.resolve<{ relevant: boolean; reason: string } | null>(null),
      shouldRunBehavioral
        ? timeGuard(this.behavioral.check({
            userMessage: input.text,
            graceResponse: validated.text,
            userContext: userContextBlock,
          }), (ms) => { behavioralGuardMs = ms; })
        : Promise.resolve<Array<{ principle: string; reason: string }>>([]),
      shouldRunCriticEarly
        ? timeGuard(this.review(precheck, input.text, validated.text, input.retrieved), (ms) => { criticGuardMs = ms; })
        : Promise.resolve<CriticReport | null>(null),
    ]);
    const guardsMs = Date.now() - guardsStart;

    if (relevanceVerdict && !relevanceVerdict.relevant) {
      topicDrift = true;
      regenViolations.push({
        code: 'relevance_check_failed',
        message: `LLM relevance check: response does NOT answer the user's latest message. Reason: ${relevanceVerdict.reason}. You MUST answer THIS message: "${input.text.slice(0, 120)}". Address the user's actual question or concern — do not give empty acknowledgment or congratulation.`,
        severity: 'regen',
      });
    }

    if (behavioralViolations.length > 0) {
      const top = behavioralViolations[0]!;
      regenViolations.push({
        code: 'behavioral_violation',
        message: `Behavioral guard flagged: ${top.principle}. ${top.reason}. Rewrite the response to follow this principle directly. ${behavioralViolations.length > 1 ? `Also fix: ${behavioralViolations.slice(1).map((v) => v.principle).join(', ')}.` : ''}`,
        severity: 'regen',
      });
    }

    if (earlyCritic) {
      critic = earlyCritic;
    }

    const needsReview =
      truncated ||
      topicDrift ||
      regenViolations.length > 0 ||
      precheck.unsupported.length > 0 ||
      shouldRunCriticEarly;

    // Snapshot the FIRST attempt's text and violations BEFORE regen reassigns
    // `validated.text`. Surfaced via OrchestratorOutput so production_issues
    // can store both the failed text AND the literal matched offending tokens.
    // Without this we're flying blind on WHY Gemini's output was rejected.
    const originalAttemptText = validated.text;
    const originalAttemptViolations = regenViolations.slice();

    // Step 7: If any check failed, regenerate with targeted feedback appended
    // to the system prompt so the LLM knows exactly what to fix.
    let reviewMs = 0;
    if (needsReview) {
      // Reuse the critic result if it ran in the parallel guard batch above;
      // otherwise we may need to run it now. Production telemetry (2026-06-03)
      // showed the critic was a HIDDEN 2-3s cost — it ran inside needsReview
      // every time a content-rule violation triggered for a non-risky intent
      // (e.g. food_question tripping a banned phrase check). That's wasted
      // work: the content checker already proved the response needs a regen,
      // and the critic's grounding/safety/tone scores can't override that.
      //
      // Critic is now only run here when there's an actual quality concern
      // it can adjudicate: truncation, topic drift, unsupported grounding
      // claims, or a risky-intent gate from the planner. Pure content-rule
      // violations on non-risky intents skip the critic and regen directly.
      const needsCritic =
        !critic &&
        (truncated ||
          topicDrift ||
          precheck.unsupported.length > 0 ||
          this.shouldRunCritic(plan, validated));
      if (needsCritic) {
        const reviewStart = Date.now();
        critic = await this.review(precheck, input.text, validated.text, input.retrieved);
        reviewMs = Date.now() - reviewStart;
      }

      // Treat a content-rule violation (forbidden food, banned phrase, DB rule)
      // as a hard fail even if the LLM-critic thinks the draft was fine — Gemini-
      // as-judge often misses dietary slips and persona violations.
      const hardFail = (critic && !critic.pass) || regenViolations.length > 0;

      if (hardFail) {
        regenerated = true;
        // Diagnostic log so we can see WHY each regen fires — production
        // telemetry showed ~1.6s tax per regen but no way to attribute the
        // cause without re-instrumenting. Logs intent + the violation codes
        // + truncation flag + critic pass.
        this.deps.logger?.info?.({
          intent: classification.type,
          truncated,
          topicDrift,
          criticPass: critic ? critic.pass : 'skipped',
          violations: regenViolations.map((v) => v.code),
          generateMs,
          guardsMs,
          reviewMs,
        }, 'orchestrator.regen_fired');
        // When the original response was truncated (length finishReason or
        // ended mid-word), add an explicit brevity instruction so the retry
        // fits comfortably inside the token budget. This is the safeguard
        // for Bug 3 in the 2026-05-30 full-feedback report — responses
        // cutting off mid-sentence multiple times per session.
        // 2026-06-04 fix: the previous addendum told the LLM to be SHORTER
        // but didn't say "keep the actual answer". Production failure: user
        // asked "what should I eat for breakfast?", initial response listed
        // 2 dishes + context (~500 chars, tripped too_long), retry stripped
        // everything except "You're at 0g protein today — your goal is 60g."
        // — no actual answer. Now we explicitly tell the retry to PRESERVE
        // the substantive answer and only trim padding/preamble.
        const truncationAddendum = truncated
          ? '\n\n━━━ TRUNCATION RECOVERY ━━━\nYour previous draft cut off mid-sentence — it was TOO LONG. Rewrite in MAXIMUM 2-3 SHORT sentences. Pure prose only. No lists. No headers. No "Here\'s a breakdown". CRITICAL: KEEP the substantive answer (specific food names, protein numbers, the actual recommendation). Trim only padding, preamble, and explanation. If the user asked what to eat, your reply MUST still name 2-3 specific foods. The message MUST end with a complete sentence and proper punctuation.\n'
          : '';
        // Critic may be skipped on non-risky intents (2026-06-03 latency cut).
        // The addendum then comes purely from the content-rule violations.
        const criticAddendum = critic ? buildCriticAddendum(critic) : '';
        const addendum =
          criticAddendum +
          (regenViolations.length > 0
            ? buildContentRegenInstruction(regenViolations, input.dietaryRestriction)
            : '') +
          truncationAddendum;
        // 2026-06-04 latency cut v2: regen is now ALWAYS small + fast + no
        // thinking. The addendum tells the model exactly what to fix and
        // demands 2-3 short sentences max — there is no reason chain-of-thought
        // or a 2048-token budget should ever be needed on retry. Even when
        // truncation forced the regen, the recovery instruction explicitly
        // says "rewrite in MAXIMUM 2-3 SHORT sentences", so 512 is enough.
        //
        // Production observation (v1 of this fix): truncated regens were
        // taking 12-14s because budget was max(1024, generationTokenBudget) =
        // 2048 for knowledge, and even with disableThinking + flash-lite the
        // model burned the budget. Hard-capping at 512 cuts decode time.
        const retryTokenBudget = 512;
        const regenStart = Date.now();
        const regenModel = 'gemini-2.5-flash-lite';
        // Diagnostic log — confirms which model / budget the regen actually
        // used, so we can verify a deploy carried the latency-cut code path.
        // Grep `orchestrator.regen_started` in fly logs to see this.
        this.deps.logger?.info?.({
          intent: classification.type,
          model: regenModel,
          budget: retryTokenBudget,
          thinking: false,
          truncated,
          topicDrift,
        }, 'orchestrator.regen_started');
        const retryResp = await this.deps.llm.generate({
          messages: [
            { role: 'system', content: baseSystem + addendum },
            // Use the SAME topic-switch-stripped history so the retry
            // doesn't re-anchor on the old assistant turn after a drift
            // failure. Without this, the regen kept producing the
            // wrong-topic answer because it still saw the muscle response
            // as the most recent assistant turn.
            ...renderHistory(generationHistory),
            { role: 'system' as const, content: focusMarker },
            { role: 'user', content: input.text },
          ],
          temperature: 0.4,
          maxOutputTokens: retryTokenBudget,
          // Unconditionally disable thinking on regen — the addendum gives the
          // model a precise correction instruction, no reasoning needed.
          disableThinking: true,
          // Unconditionally use the fast model on regen — flash-lite handles
          // deterministic rewrites as well as flash for ~50% less latency.
          model: regenModel,
        });
        regenMs = Date.now() - regenStart;
        const retryFormatted = enforceFormat(retryResp.text, enforceOpts);
        const retryValidated = validateResponse(retryFormatted.text);
        const retryPrecheck = precheckGrounding(retryValidated.text, input.retrieved);
        const retryContentViolations = checkContent(retryValidated.text, contentCheckOpts);
        // Re-check block violations on the retry; if the model still emits one,
        // fall through to safe fallback below.
        const retryBlockViolations = retryContentViolations.filter((v) => v.severity === 'block');
        const retryRegenViolations = retryContentViolations.filter(
          (v) => !v.severity || v.severity === 'regen',
        );
        // Apply quality guard to the retry too — if the regen is still
        // verbose / cluttered, fall through to safe fallback rather than
        // shipping a bad response. Same trustGemini / qualityStrict gate
        // as the initial guard above.
        const retryQualityIssue = qualityGuardActive
          ? checkResponseQuality(retryValidated.text, classification.type)
          : null;
        if (retryQualityIssue) {
          retryRegenViolations.push({
            code: retryQualityIssue.code,
            message: retryQualityIssue.message,
            severity: 'regen',
          });
        }
        // 2026-06-03 latency cut: retry critic now mirrors the initial-critic
        // gate. If the initial pass didn't need a critic (non-risky intent,
        // pure content-rule violation), the retry shouldn't need one either.
        // The retry's own content-check + grounding + truncation guards
        // already enforce correctness; the critic LLM call (~2s) was
        // hidden tax on every regen for non-risky intents.
        const needsRetryCritic =
          truncated ||
          topicDrift ||
          retryPrecheck.unsupported.length > 0 ||
          this.shouldRunCritic(plan, retryValidated);
        let retryCritic: CriticReport;
        let retryReviewMs = 0;
        if (needsRetryCritic) {
          const retryReviewStart = Date.now();
          retryCritic = await this.review(
            retryPrecheck,
            input.text,
            retryValidated.text,
            input.retrieved,
          );
          retryReviewMs = Date.now() - retryReviewStart;
        } else {
          // Synthesize a passing critic so downstream logic stays unchanged.
          // All real safety checks (content rules, block violations,
          // grounding, relevance, truncation) still run independently.
          retryCritic = {
            scores: { grounding: 5, safety: 5, on_task: 5, tone: 5 },
            overall: 20,
            pass: true,
            issues: [],
            source: 'precheck',
          };
        }
        // Fold retry-review time into the headline review bucket so the
        // dashboard reflects the true cost (or absence) of this stage.
        reviewMs += retryReviewMs;

        // Only re-check relevance if the original failure WAS a relevance/drift
        // issue. Most regens fire on content-rule violations where re-verifying
        // topical relevance after a retry adds an LLM call (~150ms) for nothing.
        let retryRelevanceFail = false;
        if (
          retryCritic.pass &&
          retryRegenViolations.length === 0 &&
          retryBlockViolations.length === 0 &&
          topicDrift &&
          lastAssistantMessage
        ) {
          const retryVerdict = await this.relevance.check(input.text, retryValidated.text, lastAssistantMessage);
          retryRelevanceFail = !retryVerdict.relevant;
        }

        // Re-check truncation on the RETRY response. Without this, a
        // retry that ALSO ends mid-sentence (Gemini bumped against the
        // 8192 cap again) would ship as-is — exactly the "partial
        // answer" failure the hard rule (2026-06-03) forbids.
        const retryTruncated =
          retryResp.finishReason === 'length' ||
          endsMidWord(retryValidated.text) ||
          retryFormatted.fixes.includes('truncation_suspected');

        if (retryCritic.pass && retryRegenViolations.length === 0 && retryBlockViolations.length === 0 && !retryRelevanceFail && !retryTruncated) {
          validated = retryValidated;
          critic = retryCritic;
        } else {
          // 2026-06-03 latency cut: web-search fallback only fires for intents
          // where grounding in current research genuinely matters (knowledge,
          // medication_question). For food_question / general / emotional /
          // social_situation / etc., the system prompt already contains the
          // GLP-1 food rules + dietary filter + user context, and Google
          // Search adds a 3-4s LLM call (with grounding) for no quality gain.
          // Skipping it saves ~4s on every regen-failure path.
          const WEB_SEARCH_INTENTS = new Set([
            'knowledge',
            'medication_question',
            'appointment_prep',
          ]);
          const shouldTryWebSearch = WEB_SEARCH_INTENTS.has(classification.type);
          let webResult: ValidationResult | null = null;
          let webSearchMs = 0;
          if (shouldTryWebSearch) {
            const webStart = Date.now();
            // Step 8: Web search fallback — last resort before the canned safe
            // fallback. Calls Gemini with Google Search grounding when the KB
            // has no answer. Content rules still apply.
            webResult = await this.tryWebSearchFallback(
              baseSystem,
              input.text,
              input.history,
              contentCheckOpts,
              stripName,
            );
            webSearchMs = Date.now() - webStart;
            // Fold into the existing regen telemetry bucket so the dashboard
            // shows this cost without a new column.
            regenMs += webSearchMs;
          }
          if (webResult) {
            validated = webResult;
            critic = retryCritic;
          } else {
            validated = {
              text: getToolAwareFallback(classification.type, toolResults, { isReasoningRequest, ...(lastAssistantMessage ? { lastAssistantMessage } : {}), ...(input.text ? { userMessage: input.text } : {}), ...(input.dietaryRestriction ? { dietaryRestriction: input.dietaryRestriction } : {}), ...(input.foodDislikes && input.foodDislikes.length > 0 ? { foodDislikes: input.foodDislikes } : {}) }),
              confidence: 'low',
              flags: ['safe_fallback'],
            };
            critic = retryCritic;
            usedSafeFallback = true;
          }
        }
      }
    }

    // ── Final completeness safety net (2026-06-03 hard rule) ─────────────
    // Last line of defense before send: even after regen + web-search
    // fallback, if the response STILL ends mid-sentence (e.g. retry was
    // also truncated, web search returned a fragment), trim back to the
    // last complete sentence boundary. If trimming leaves nothing usable
    // (<40 chars or no terminal punctuation anywhere), fall back to the
    // canned safe response — better to say "give me a bit more detail"
    // than to ship a half-thought.
    let finalText = validated.text;
    if (!usedSafeFallback && endsMidWord(finalText)) {
      // ITERATIVE trim: a single trim might leave a residue that ALSO ends
      // mid-sentence (e.g. unmatched paren earlier in the text). Keep
      // trimming back to earlier sentence boundaries until the result is
      // clean OR we run out of complete sentences. Bounded to 6 iterations
      // so a pathological response (every sentence has unmatched brackets)
      // can't loop forever — at that point we fall to the safe template.
      let candidate = finalText;
      let cleaned = false;
      for (let i = 0; i < 6; i++) {
        const { trimmed, wasTrimmed } = trimToLastCompleteSentence(candidate);
        if (!wasTrimmed || trimmed.length < 40) break;
        candidate = trimmed;
        if (!endsMidWord(candidate)) { cleaned = true; break; }
      }
      if (cleaned) {
        finalText = candidate;
      } else {
        finalText = getToolAwareFallback(classification.type, toolResults, { isReasoningRequest, ...(lastAssistantMessage ? { lastAssistantMessage } : {}), ...(input.text ? { userMessage: input.text } : {}), ...(input.dietaryRestriction ? { dietaryRestriction: input.dietaryRestriction } : {}), ...(input.foodDislikes && input.foodDislikes.length > 0 ? { foodDislikes: input.foodDislikes } : {}) });
        usedSafeFallback = true;
      }
    }

    return {
      text: finalText,
      confidence: validated.confidence,
      intent: plan.intent,
      toolResults,
      usedRetrieval: input.retrieved.length > 0,
      latencyMs: Date.now() - started,
      internalTimings: {
        tools: toolsMs,
        generate: generateMs,
        postgen: postgenMs,
        guards: guardsMs,
        guardRelevance: relevanceGuardMs,
        guardBehavioral: behavioralGuardMs,
        guardCritic: criticGuardMs,
        review: reviewMs,
        regen: regenMs,
        thinkingDisabled: isSimpleMessage,
      },
      ...(critic ? { critic } : {}),
      ...(regenerated ? { regenerated } : {}),
      ...(usedSafeFallback ? { usedSafeFallback } : {}),
      // Surface which guards triggered regen so ai.service.ts can feed the
      // production-issue capture loop with the actual cause. Empty array
      // when nothing fired (clean response, no regen).
      regenTriggerCodes: regenViolations.map((v) => v.code),
      // Full violation detail (code + literal matched text + reason). Without
      // this, production_issues only tells us "banned_phrase fired" but not
      // WHICH banned phrase — making targeted fixes impossible.
      regenViolationDetails: (regenerated ? originalAttemptViolations : regenViolations)
        .map((v) => ({
          code: v.code,
          ...(v.match ? { match: v.match } : {}),
          ...(v.message ? { message: v.message } : {}),
        })),
      // First-attempt text — preserved across regen so we can see what
      // Gemini originally wanted to say when the final output is a safe
      // fallback or a re-written regen.
      ...(regenerated || usedSafeFallback ? { originalAttemptText } : {}),
    };
  }

  /**
   * Last-resort: call Gemini with Google Search grounding enabled. Used
   * when both the primary attempt and the regen failed. Returns the cleaned
   * text on success, or null if web search also produced something we can't
   * send (block violation, empty, or generation error).
   *
   * Grounding precheck is skipped here — the model's response IS grounded
   * by Google. Block-severity content rules still apply (e.g. "I prescribe"
   * is never OK, even if the web says it).
   */
  private async tryWebSearchFallback(
    baseSystem: string,
    userText: string,
    history: OrchestratorInput['history'],
    contentCheckOpts: Parameters<typeof checkContent>[1],
    stripName: string | undefined,
  ): Promise<ValidationResult | null> {
    try {
      const webResp = await this.deps.llm.generate({
        messages: [
          {
            role: 'system',
            content:
              baseSystem +
              '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' +
              '\nWEB RESEARCH MODE — last resort before falling back' +
              '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' +
              '\nYour knowledge base had no confident answer. Use Google Search to find:' +
              '\n  1. Peer-reviewed research, clinical studies, or systematic reviews on GLP-1 medications' +
              '\n  2. Guidelines from major medical bodies (Endocrine Society, ADA, FDA, NIH)' +
              '\n  3. Recent (last 2 years) evidence-based GLP-1 nutrition and exercise research' +
              '\nPrefer scientific sources over blogs or product sites.' +
              '\n' +
              '\nThen answer in Grace\'s voice: warm, brief (2-4 sentences), no clinical jargon, no markdown, no citations or URLs in the reply (you don\'t need to name sources).' +
              '\nIf web search also returns nothing useful, say honestly in one sentence that you couldn\'t find a reliable answer and suggest the user ask their prescriber.',
          },
          ...renderHistory(history),
          { role: 'user', content: userText },
        ],
        temperature: 0.4,
        // Web-search fallback used to be 8192 — but quality-guard rejects
        // anything over 800 chars even for the heaviest intent (appointment_
        // prep). 2048 = ~1500 grounded-thinking + 500 output, fits every
        // realistic answer. Same truncation-cascade prevention as the main
        // generate path.
        maxOutputTokens: 2048,
        useGoogleSearch: true,
      });
      const formatted = enforceFormat(webResp.text, { ...(stripName ? { stripFirstName: stripName } : {}) });
      const validated = validateResponse(formatted.text);
      if (!validated.text || validated.text.trim().length === 0) return null;
      const webViolations = checkContent(validated.text, contentCheckOpts);
      // Only block-severity violations disqualify the web result. The response
      // is already Google Search-grounded so regen violations (e.g. style rules)
      // don't apply — we can't regen from a grounded result anyway. Block rules
      // (e.g. prescribing language) still apply unconditionally.
      if (webViolations.some((v) => v.severity === 'block')) return null;
      return validated;
    } catch {
      return null;
    }
  }

  /**
   * Single review step. If the deterministic precheck already flagged
   * unsupported quantitative/safety claims, synthesize a failing
   * CriticReport directly — no LLM call needed. Otherwise call the
   * LLM-critic and attach the (empty) precheck info for observability.
   */
  private async review(
    precheck: GroundingResult,
    userText: string,
    response: string,
    retrieved: RetrievedDoc[],
  ): Promise<CriticReport> {
    if (precheck.unsupported.length > 0) {
      return synthesizePrecheckFailure(precheck);
    }
    return this.critic.evaluate({ userText, response, retrieved });
  }

  /**
   * Risk-gate: the LLM-critic costs an extra Gemini call per message.
   * We only invoke it where the failure modes are dangerous or expensive
   * (medical advice, KB lookups, low-confidence drafts). The grounding
   * precheck runs independently and can force review even when this gate
   * would have skipped.
   */
  private shouldRunCritic(plan: PlannerDecision, v: ValidationResult): boolean {
    if (v.confidence === 'low') return true;
    if (v.flags.includes('possible_medical_advice')) return true;
    if (RISKY_INTENT_PREFIXES.some((p) => plan.intent.startsWith(p))) return true;
    return false;
  }
}

function synthesizePrecheckFailure(precheck: GroundingResult): CriticReport {
  const claims = summarizeUnsupported(precheck.unsupported);
  return {
    scores: { grounding: 1, safety: 2, on_task: 4, tone: 4 },
    overall: 11,
    pass: false,
    issues: claims,
    unsupportedClaims: precheck.unsupported.map((c) => c.text),
    source: 'precheck',
  };
}

function buildCriticAddendum(c: CriticReport): string {
  const unsupported = c.unsupportedClaims ?? [];
  const issues = c.issues ?? [];

  const parts: string[] = ['\n\nREVIEWER FEEDBACK on your previous draft:'];

  if (unsupported.length > 0) {
    parts.push(
      `These specific claims were not supported by the knowledge base and MUST be removed: ${unsupported.map((x) => `"${x}"`).join(', ')}.`,
    );
  }
  if (issues.length > 0) {
    parts.push('Issues to fix:');
    for (const i of issues) parts.push(`- ${i}`);
  }

  parts.push(
    "Rewrite the response. Be brief and warm. Never assert specific doses, durations, frequencies, percentages, or drug-interaction safety unless those exact facts appear in retrieved knowledge. For anything dose- or medication-specific, defer to the user's prescribing clinician.",
  );

  return parts.join('\n');
}

/**
 * Heuristic for mid-word/mid-sentence truncation.
 * Returns true when the response clearly ends in the middle of something —
 * a trailing dash/hyphen, a single letter, an article ("the", "a"), a
 * preposition ("of", "on", "for"), a stranded conjunction, a trailing
 * comma/colon/semicolon, an open paren, or no terminal punctuation/emoji.
 *
 * Production-critical: a partial answer is worse than no answer. The hard
 * rule (2026-06-03) is "never end mid-sentence" — this is the gate.
 */
export function endsMidWord(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Ends in a dash/hyphen → mid-word
  if (/[-–—]$/.test(trimmed)) return true;
  // Ends with a trailing comma / colon / semicolon → mid-clause
  if (/[,:;]$/.test(trimmed)) return true;
  // Ends with an open paren/bracket/quote → mid-quote
  if (/[(\[{"'`]$/.test(trimmed)) return true;
  // Ends with a mathematical operator → stranded calculation
  if (/[+\-*/=×÷±]\s*$/.test(trimmed)) return true;
  // Ends with a percent sign or currency symbol with no preceding number nearby
  // (handled by the punctuation check below — percent / currency at end is fine
  //  e.g. "lost 5%." but "lost %" would fail the no-terminator check.)
  // Bracket balance (incl. parens, square, curly, angle)
  const openParens = (trimmed.match(/\(/g) ?? []).length;
  const closeParens = (trimmed.match(/\)/g) ?? []).length;
  if (openParens > closeParens) return true;
  const openSquare = (trimmed.match(/\[/g) ?? []).length;
  const closeSquare = (trimmed.match(/\]/g) ?? []).length;
  if (openSquare > closeSquare) return true;
  const openCurly = (trimmed.match(/\{/g) ?? []).length;
  const closeCurly = (trimmed.match(/\}/g) ?? []).length;
  if (openCurly > closeCurly) return true;
  // Same check for double-quotes (odd count = unclosed quote).
  const doubleQuotes = (trimmed.match(/"/g) ?? []).length;
  if (doubleQuotes % 2 === 1) return true;
  // Open markdown bold (** unbalanced)
  const boldMarkers = (trimmed.match(/\*\*/g) ?? []).length;
  if (boldMarkers % 2 === 1) return true;
  // Empty markdown header at end: "## " or "### " alone on a line
  if (/(?:^|\n)#{1,6}\s*$/.test(trimmed)) return true;
  // Empty list-item bullet at end: "- " / "* " / "• " / "1. " with no content
  if (/(?:^|\n)\s*(?:[-*•]|\d+\.)\s*$/.test(trimmed)) return true;
  // Stranded hedge / connector words at end of last sentence — almost always
  // followed by content the model dropped.
  const lastSentence = trimmed.split(/(?<=[.!?])\s+/).pop() ?? trimmed;
  const lastSentenceLower = lastSentence.toLowerCase().replace(/[.!?]+$/, '').trim();
  // Hedge words: when these end a sentence, the model dropped the value/clause
  // that should have followed (e.g. "Eat around" → "around 60g"). Only includes
  // words that REQUIRE follow-on content; excludes ambiguous ones like "next"
  // (valid: "Try this next.") and "first" (valid: "Eat that first.").
  const hedgeStrandedRe = /\b(approx|approximately|around|about|roughly|nearly|almost|just over|just under|just below|just above|less than|more than|up to|at least|at most|such as|including|for example|e\.g|i\.e|namely|notably|that is|which is|that includes?|that contains?|that has|that provides?|due to|because of|in order to|so that|such that|so as to|in case|provided that|assuming that|given that|considering that|despite|even though|in spite of|on the other hand|in contrast|finally|moreover|furthermore|however|nevertheless|therefore|consequently|as a result|in addition|on top of)\s*[,(]?\s*$/i;
  if (hedgeStrandedRe.test(lastSentenceLower)) return true;
  const lastTokRaw = trimmed.split(/\s+/).pop() ?? "";
  // Strip trailing terminator punctuation so "when." matches "when" stranded.
  const lastTok = lastTokRaw.replace(/[.!?…,;:]+$/, '');
  // Ends with a stranded preposition / article / conjunction / linking verb
  // 2026-06-04: restricted to words that ALMOST NEVER validly end a sentence.
  // Excluded: more, less, most, least, all, none, here, there, where, now,
  // first, second, third, last, next (these often end complete sentences:
  // "Tell me more", "That's all", "Go there", "I'll try the tofu first").
  // Included: articles, most prepositions, auxiliary verbs that need a main
  // verb (is, was, been, being, am), subordinating conjunctions that need a
  // clause (when, if, because, since, while, though, although, whether,
  // unless, until), coordinators that need a tail (and, or, but, nor, so).
  const stranded = /^(the|a|an|of|on|in|to|for|with|and|or|but|so|by|at|as|is|are|was|were|be|been|being|am|because|since|while|though|although|when|if|then|than|that|its|their|your|our|my|his|her|into|onto|upon|via|including|such|without|within|throughout|across|between|among|alongside|toward|towards|after|before|until|unless|whether|either|neither|nor)$/i;
  if (stranded.test(lastTok)) return true;
  // Bare number followed by no unit at end (e.g. "around 60" → likely
  // "60 grams" / "60 minutes" cut off). Only fires when the second-to-last
  // token suggests a quantity is expected.
  if (/^\d+(?:\.\d+)?$/.test(lastTok) && trimmed.length > 8) {
    const prevTok = trimmed.split(/\s+/).slice(-2, -1)[0]?.toLowerCase() ?? '';
    if (/^(about|around|approximately|roughly|nearly|almost|over|under|up to|at least|just|exactly|around|just|maybe|like)$/i.test(prevTok)) {
      return true;
    }
  }
  // No terminal punctuation or emoji at all
  if (!/[.!?…)\]}'"`]$|[\p{Extended_Pictographic}]$/u.test(trimmed)) return true;
  // 2026-06-04 production failure: response ended with "...(e.g. ... high-protein?) 2."
  // — a stranded numbered list intro ("2." with no content after). Pattern:
  // text ends with a digit + period + optional whitespace, AND an earlier
  // numbered item exists ("1. <content>"). Means the list was started but
  // not finished.
  const endsWithStrandedListNumRe = /\b(\d+)\.\s*$/;
  const endMatch = trimmed.match(endsWithStrandedListNumRe);
  if (endMatch) {
    const endNum = parseInt(endMatch[1]!, 10);
    if (endNum >= 1 && endNum <= 20) {
      // Did an earlier numbered item appear with actual content after it?
      const earlierItemsRe = new RegExp(`(?:^|[\\s\\S])(\\d+)\\.\\s+\\S`, 'g');
      let prev = 0;
      let m: RegExpExecArray | null;
      while ((m = earlierItemsRe.exec(trimmed)) !== null) {
        const n = parseInt(m[1]!, 10);
        if (n < endNum) { prev = Math.max(prev, n); }
      }
      // If we saw an earlier numbered item (e.g. "1. Your Goals,..."), the
      // ending "2." is a stranded list intro.
      if (prev > 0) return true;
    }
  }
  return false;
}

/**
 * Final safety net: trim a (possibly truncated) response back to its last
 * COMPLETE sentence ending. Returns the trimmed text + whether trimming
 * happened. If no complete sentence boundary exists, returns the original
 * unchanged so the caller can fall back to the safe canned reply.
 *
 * Examples:
 *   "Good. The protein math works out to about 25g for that, and"
 *     → "Good. The protein math works out to about 25g for that," ← still
 *        truncated by endsMidWord; we trim BEFORE the partial clause:
 *     → "Good." (first complete sentence)
 *   "Got it, about 25g. You're at 60g today." → unchanged (already complete)
 */
export function trimToLastCompleteSentence(text: string): { trimmed: string; wasTrimmed: boolean } {
  const original = text.trim();
  if (original.length === 0) return { trimmed: '', wasTrimmed: false };
  // Match a sentence terminator (. ! ? …) optionally followed by a closing
  // quote/paren, then either a space, newline, or end-of-string.
  const sentenceEnd = /[.!?…][")\]]?(?=\s|$)/g;
  let lastIdx = -1;
  let match: RegExpExecArray | null;
  while ((match = sentenceEnd.exec(original)) !== null) {
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx === -1) return { trimmed: original, wasTrimmed: false };
  const trimmed = original.slice(0, lastIdx).trim();
  return { trimmed, wasTrimmed: trimmed.length < original.length };
}
