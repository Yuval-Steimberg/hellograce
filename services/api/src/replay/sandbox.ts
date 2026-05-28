// Sandbox replay — runs user messages through the REAL AIOrchestrator
// with in-memory mock state, NOT a direct llm.generate call. The output
// is what production WhatsApp would actually send: post format-enforcer,
// content checker, relevance check, quality guard, regen loops.
//
// Tools (log_food, get_food_summary, etc.) are mocked with in-memory state
// so each replay turn properly updates today's food log and totals.

import {
  AIOrchestrator,
  type Tool,
  ToolRegistry,
  classifyMessage,
} from '@grace/ai-core';
import type {
  LLMProvider,
  ChatTurn,
  PlannerDecision,
  RetrievedDoc,
  OrchestratorOutput,
  DietaryRestriction,
} from '@grace/shared';

export interface ReplayPersona {
  firstName?: string;
  medication?: string;
  dietaryRestriction?: DietaryRestriction;
  foodDislikes?: string[];
  proteinGoalGrams?: number;
  calorieGoalKcal?: number;
  glp1WeekNumber?: number;
  preloadedFoods?: Array<{ food: string; protein_g: number; calories: number }>;
}

export interface ReplayTurn {
  role: 'user' | 'grace';
  text: string;
  latencyMs: number;
  bannedPhrases: string[];
  meta?: {
    intent: string;
    confidence: string;
    toolCalls: Array<{ name: string; ok: boolean; output?: unknown; error?: string; latencyMs: number }>;
    regenerated: boolean;
    usedSafeFallback: boolean;
    criticPass?: boolean;
    criticIssues?: string[];
  };
}

const BANNED_PHRASES = [
  'too fast and potentially unhealthy', 'a very significant amount', 'oh dear',
  'contact your healthcare provider right away', 'thanks for the feedback',
  "i'll work on that", 'my connection blipped', 'previous total',
  'new daily total', 'remaining for the day', "let's break down",
  "you're making progress", 'could you tell me if that was', 'vegetarian big mac',
  "i can't tell you exactly", "that's a significant accomplishment",
  'great that you achieved', 'congratulations on',
  "i don't know your calorie target", "i don't know what you've eaten",
];

/** In-memory food log used by the mock log_food and get_food_summary tools. */
interface MockFoodState {
  items: Array<{ food: string; protein_g: number; calories: number; created_at: Date }>;
}

function makeMockLogFood(state: MockFoodState, llm: LLMProvider): Tool {
  return {
    name: 'log_food',
    description: 'Log a meal and return the running daily totals.',
    async execute(args: Record<string, unknown>) {
      const food = String(args.food ?? '').trim();
      if (!food) return { ok: false, error: 'no_food' };
      // Use the LLM to estimate macros (same as production)
      try {
        const resp = await llm.generate({
          messages: [
            {
              role: 'system',
              content: 'Estimate protein and calories from a casual food description. Return ONLY JSON: {"protein_g": <int>, "calories": <int>}',
            },
            { role: 'user', content: food },
          ],
          temperature: 0.0,
          maxOutputTokens: 100,
          responseFormat: 'json',
          model: 'gemini-2.0-flash',
        });
        const cleaned = resp.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
        const parsed = JSON.parse(cleaned) as { protein_g?: number; calories?: number };
        const protein_g = Math.round(parsed.protein_g ?? 0);
        const calories = Math.round(parsed.calories ?? 0);
        state.items.push({ food, protein_g, calories, created_at: new Date() });
        const daily_protein_g = state.items.reduce((s, i) => s + i.protein_g, 0);
        const daily_calories = state.items.reduce((s, i) => s + i.calories, 0);
        return { food, protein_g, calories, daily_protein_g, daily_calories };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function makeMockGetFoodSummary(state: MockFoodState, persona: ReplayPersona): Tool {
  return {
    name: 'get_food_summary',
    description: "Retrieve today's protein, calories, and food items logged.",
    async execute() {
      const protein_g = state.items.reduce((s, i) => s + i.protein_g, 0);
      const calories = state.items.reduce((s, i) => s + i.calories, 0);
      const proteinTarget = persona.proteinGoalGrams ?? 80;
      const calorieTarget = persona.calorieGoalKcal ?? null;
      return {
        protein_g,
        calories,
        items: state.items.map((i) => i.food),
        items_count: state.items.length,
        protein_goal_grams: proteinTarget,
        protein_goal_met: protein_g >= proteinTarget,
        protein_remaining_g: Math.max(0, proteinTarget - protein_g),
        calorie_goal_kcal: calorieTarget,
        calorie_goal_met: calorieTarget != null && calories >= calorieTarget,
        calories_remaining: calorieTarget != null ? Math.max(0, calorieTarget - calories) : null,
      };
    },
  };
}

function makeMockGetUserProfile(persona: ReplayPersona): Tool {
  return {
    name: 'get_user_profile',
    description: 'Return the user profile snapshot.',
    async execute() {
      return {
        first_name: persona.firstName ?? null,
        medication: persona.medication ?? null,
        dietary_restriction: persona.dietaryRestriction?.label ?? null,
        protein_goal_grams: persona.proteinGoalGrams ?? null,
        calorie_goal_kcal: persona.calorieGoalKcal ?? null,
        glp1_week: persona.glp1WeekNumber ?? null,
        food_dislikes: persona.foodDislikes ?? [],
      };
    },
  };
}

function buildContextBlock(persona: ReplayPersona, state: MockFoodState): string {
  const lines: string[] = ['━━━ THIS USER\'S DATA (background only — do NOT dump into responses) ━━━'];
  if (persona.firstName) lines.push(`Name: ${persona.firstName}`);
  if (persona.medication) lines.push(`Medication: ${persona.medication}`);
  if (persona.dietaryRestriction) lines.push(`Dietary restriction: ${persona.dietaryRestriction.label}`);
  if (persona.foodDislikes?.length) lines.push(`Food dislikes: ${persona.foodDislikes.join(', ')}`);
  if (persona.proteinGoalGrams) lines.push(`Personal daily protein target: ${persona.proteinGoalGrams}g`);
  if (persona.calorieGoalKcal) {
    lines.push(`Personal daily calorie target: ${persona.calorieGoalKcal} kcal — express as range ±100 to avoid false precision`);
  }
  if (persona.glp1WeekNumber) lines.push(`GLP-1 week: Week ${persona.glp1WeekNumber}`);

  const protein_g = state.items.reduce((s, i) => s + i.protein_g, 0);
  const calories = state.items.reduce((s, i) => s + i.calories, 0);
  if (persona.proteinGoalGrams) {
    lines.push(`Total protein TODAY: ${protein_g}g / ${persona.proteinGoalGrams}g target (${Math.max(0, persona.proteinGoalGrams - protein_g)}g remaining)`);
  } else if (protein_g > 0) {
    lines.push(`Total protein TODAY: ${protein_g}g`);
  }
  if (persona.calorieGoalKcal) {
    lines.push(`Total calories TODAY: ${calories} kcal / ${persona.calorieGoalKcal} kcal target (${Math.max(0, persona.calorieGoalKcal - calories)} kcal remaining)`);
  } else if (calories > 0) {
    lines.push(`Total calories TODAY: ${calories} kcal`);
  }
  if (state.items.length > 0) {
    lines.push(`Foods logged today: ${state.items.map((i) => i.food).slice(0, 8).join('; ')}`);
  }
  lines.push('━━━ END OF USER DATA ━━━');
  return lines.join('\n');
}

export interface RunReplayOpts {
  messages: string[];
  persona: ReplayPersona;
  systemPrompt: string;
  llm: LLMProvider;
}

export async function runSandboxReplay(opts: RunReplayOpts): Promise<{ turns: ReplayTurn[] }> {
  const turns: ReplayTurn[] = [];
  const history: ChatTurn[] = [];
  const state: MockFoodState = {
    items: (opts.persona.preloadedFoods ?? []).map((f) => ({
      ...f,
      created_at: new Date(),
    })),
  };

  const tools = new ToolRegistry();
  tools.register(makeMockLogFood(state, opts.llm));
  tools.register(makeMockGetFoodSummary(state, opts.persona));
  tools.register(makeMockGetUserProfile(opts.persona));

  const orchestrator = new AIOrchestrator({ llm: opts.llm, tools });

  for (const userMsg of opts.messages) {
    turns.push({ role: 'user', text: userMsg, latencyMs: 0, bannedPhrases: [] });

    const t0 = Date.now();
    let output: OrchestratorOutput;
    try {
      // Build the system prompt with the live persona + state context appended
      const fullPrompt = `${opts.systemPrompt}\n\n${buildContextBlock(opts.persona, state)}`;
      const retrieved: RetrievedDoc[] = [];
      const classification = classifyMessage(userMsg);

      // Pre-plan: force log_food / get_food_summary on classifier match (same as ai.service.ts)
      let prePlannedDecision: PlannerDecision | undefined;
      if (classification.type === 'food_log') {
        prePlannedDecision = {
          intent: 'log_food',
          needsTools: true,
          toolCalls: [{ name: 'log_food', args: { food: userMsg } }],
          rationale: 'classifier_forced_log_food',
        };
      } else if (
        classification.type === 'food_question' &&
        /\b(protein|calorie|kcal|carb|eat|overeat|left|remaining)\b/i.test(userMsg)
      ) {
        prePlannedDecision = {
          intent: 'get_food_summary',
          needsTools: true,
          toolCalls: [{ name: 'get_food_summary', args: {} }],
          rationale: 'classifier_forced_get_food_summary',
        };
      }

      output = await orchestrator.run({
        userId: 'replay-sandbox',
        text: userMsg,
        history,
        retrieved,
        toolsEnabled: true,
        systemPrompt: fullPrompt,
        ...(opts.persona.dietaryRestriction ? { dietaryRestriction: opts.persona.dietaryRestriction } : {}),
        ...(opts.persona.firstName ? { userFirstName: opts.persona.firstName } : {}),
        ...(opts.persona.foodDislikes?.length ? { foodDislikes: opts.persona.foodDislikes } : {}),
        isFirstMessage: turns.length === 1,
        ...(prePlannedDecision ? { prePlannedDecision } : {}),
      });
    } catch (err) {
      turns.push({
        role: 'grace',
        text: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - t0,
        bannedPhrases: [],
      });
      continue;
    }

    const text = output.text;
    const lower = text.toLowerCase();
    const bannedHits = BANNED_PHRASES.filter((b) => lower.includes(b));

    turns.push({
      role: 'grace',
      text,
      latencyMs: output.latencyMs,
      bannedPhrases: bannedHits,
      meta: {
        intent: output.intent,
        confidence: output.confidence,
        toolCalls: output.toolResults.map((r: import('@grace/shared').ToolResult) => ({
          name: r.name,
          ok: r.ok,
          ...(r.output !== undefined ? { output: r.output } : {}),
          ...(r.error !== undefined ? { error: r.error } : {}),
          latencyMs: r.latencyMs,
        })),
        regenerated: !!output.regenerated,
        usedSafeFallback: !!output.usedSafeFallback,
        ...(output.critic ? { criticPass: output.critic.pass, criticIssues: output.critic.issues } : {}),
      },
    });

    const now = new Date();
    history.push({ role: 'user', content: userMsg, createdAt: now });
    history.push({ role: 'assistant', content: text, createdAt: now });
  }

  return { turns };
}
