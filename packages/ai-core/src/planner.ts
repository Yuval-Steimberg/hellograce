import type { LLMProvider, PlannerDecision, ToolCall } from '@grace/shared';

const PLANNER_SYSTEM = `You are Grace's planner. Decide the user's intent and whether to invoke tools.
Respond with ONLY a JSON object:
{
  "intent": "<one of: chat, log_food, log_weight, log_mood, log_water, injection, side_effect, schedule_change, knowledge_lookup, safety_emergency, safety_crisis>",
  "needsTools": <boolean>,
  "toolCalls": [{ "name": "<tool_name>", "args": { ... } }],
  "rationale": "<one sentence>"
}
Available tools: log_food, log_weight, log_mood, knowledge_search.
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
