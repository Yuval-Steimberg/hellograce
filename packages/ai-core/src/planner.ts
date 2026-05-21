import type { LLMProvider, PlannerDecision, ToolCall } from '@grace/shared';

const PLANNER_SYSTEM = `You are Grace's planner. Decide the user's intent and which tools to call.
Respond with ONLY a JSON object:
{
  "intent": "<one of: chat, log_food, log_weight, log_mood, side_effect, schedule_change, knowledge_lookup, safety_emergency, safety_crisis>",
  "needsTools": <boolean>,
  "toolCalls": [{ "name": "<tool_name>", "args": { ... } }],
  "rationale": "<one sentence>"
}

AVAILABLE TOOLS — call when the user's message clearly matches:
- log_food: user mentions eating or drinking something. args: { "food": "<full description, all items in one string>" }
- log_weight: user reports their weight. args: { "weight_lbs": <number> }
- log_mood: user rates their mood or energy. args: { "score": <1-10> }
- log_side_effect: user describes a side effect (nausea, fatigue, constipation, hair loss, etc.). args: { "effect": "<effect name>" }
- knowledge_search: user asks a GLP-1/medication/nutrition question that needs factual backing. args: { "query": "<search query>" }
- get_weight_trend: user asks about their weight loss progress, trend, or history. args: {}
- get_food_summary: user asks how much protein or calories they've had today. args: {}
- get_user_profile: user asks about their own profile, goals, or medication details. args: {}
- remove_food: user wants to delete a food they logged by mistake, says something was from yesterday, or asks to remove a specific food. args: { "food": "<food name to remove>" }

CRITICAL — "HOW MUCH PROTEIN TODAY" QUESTIONS:
When the user asks about their daily/today totals ("how many proteins did i eat today", "how much protein so far", "what's my protein count", "my calories today"), use get_food_summary — NEVER log_food, even if the phrase contains "ate" or "had".
✓ "how many proteins i ate today" → [{name:"get_food_summary"}]
✓ "what's my protein count" → [{name:"get_food_summary"}]
✗ Do NOT call log_food on these — they are queries, not new food entries.

CRITICAL — COMPOUND FOOD MEALS:
When the user logs multiple items in ONE meal ("salad and omelet", "chicken with rice and broccoli", "yogurt, granola, and banana"), make ONE log_food call with the FULL description as the food arg — never split into multiple log_food calls.
✓ "ate salad and an omelet with 2 eggs" → [{name:"log_food", args:{food:"salad and an omelet with 2 eggs"}}]
✗ split into [{food:"salad"}, {food:"omelet with 2 eggs"}] — the tool sums correctly itself
✗ drop items: {food:"salad"} alone loses the omelet

Call multiple tools if the message warrants it (e.g. log_food + get_food_summary after a meal log).
IMPORTANT: if the user says "remove", "delete", "that was from yesterday", or "undo" a food — use remove_food, NOT log_food.
If unsure, return intent="chat", needsTools=false, toolCalls=[].`;

export class PlannerAgent {
  constructor(private llm: LLMProvider) {}

  async plan(userText: string): Promise<PlannerDecision> {
    const resp = await this.llm.generate({
      messages: [
        { role: 'system', content: PLANNER_SYSTEM },
        { role: 'user', content: userText },
      ],
      temperature: 0.1,
      maxOutputTokens: 300,
      responseFormat: 'json',
    });

    return parsePlannerResponse(resp.text);
  }
}

export function parsePlannerResponse(raw: string): PlannerDecision {
  const fallback: PlannerDecision = {
    intent: 'chat',
    needsTools: false,
    toolCalls: [],
    rationale: 'planner-fallback',
  };
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    const obj = JSON.parse(cleaned) as Partial<PlannerDecision>;
    if (typeof obj.intent !== 'string') return fallback;
    return {
      intent: obj.intent,
      needsTools: !!obj.needsTools,
      toolCalls: Array.isArray(obj.toolCalls) ? (obj.toolCalls as ToolCall[]) : [],
      rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
    };
  } catch {
    return fallback;
  }
}
