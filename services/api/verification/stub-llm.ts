// Deterministic, latency-controllable LLM stub for execution-path verification.
//
// Implements the same LLMProvider interface production wires to Gemini, but:
//   - classifies every call by the system-prompt marker of the caller
//     (planner / generation / relevance / behavioral / critic / workers / …)
//   - records every call with start/end timestamps so the runner can PROVE
//     which guards ran, in what order, and whether they overlapped (parallel)
//   - lets scenarios script the next generation output (including deliberately
//     bad output) to verify the guard layers catch it in real execution
//   - applies a configurable per-class delay so end-to-end latency can be
//     modeled with production-like LLM round-trip times.
import type { LLMProvider, LLMRequest, LLMResponse } from '@grace/shared';

export type CallClass =
  | 'planner'
  | 'generation'
  | 'food_question_direct'
  | 'emergency_fallback'
  | 'relevance_check'
  | 'behavioral_guard'
  | 'critic'
  | 'macro_estimate'
  | 'food_itemize'
  | 'food_decompose'
  | 'conversation_summary'
  | 'fact_extractor'
  | 'memory_md_updater'
  | 'user_memory_extract'
  | 'web_search'
  | 'search_food_ideas'
  | 'unknown';

export interface RecordedCall {
  seq: number;
  cls: CallClass;
  model: string | undefined;
  startedAt: number;
  endedAt: number;
  promptChars: number;
  maxOutputTokens: number | undefined;
  disableThinking: boolean | undefined;
  systemHead: string;
  userText: string;
  responseText: string;
  /** Full concatenated prompt (all roles), capped — lets checks assert what
   *  context actually reached the model (facts, history, stripped topics). */
  fullText: string;
}

const MARKERS: Array<[CallClass, string]> = [
  ['planner', "You are Grace's planner"],
  ['relevance_check', 'quality checker for a chatbot called Grace'],
  ['behavioral_guard', 'strict behavioral quality checker'],
  ['critic', 'strict reviewer for Grace'],
  // Order matters — more specific markers first.
  ['food_itemize', 'estimate protein and calories for each distinct food item'],
  ['food_itemize', 'Decompose this food description into per-item protein and calories'],
  ['food_decompose', 'You decompose a casual food description into items with estimated weights'],
  ['macro_estimate', 'Estimate protein and calories'],
  ['conversation_summary', 'You compress a WhatsApp conversation'],
  ['fact_extractor', 'You extract DURABLE personal facts'],
  ['memory_md_updater', 'You maintain a per-user memory.md file'],
  ['user_memory_extract', 'You extract durable facts about a GLP-1 user'],
  ['web_search', 'WEB RESEARCH MODE'],
  ['food_question_direct', 'The user is asking what to eat or for food recommendations'],
  ['emergency_fallback', 'ONE OR TWO short sentences'],
];

export interface StubDelays {
  /** ms added per call class. Anything unlisted uses `default`. */
  [cls: string]: number;
}

export class StubLLM implements LLMProvider {
  readonly id = 'stub';
  calls: RecordedCall[] = [];
  private seq = 0;

  /** FIFO of scripted generation outputs. When empty, a sane default reply
   *  derived from the user message is produced. */
  private scriptedGenerations: string[] = [];
  /** When set, the NEXT relevance check fails once (then auto-resets). */
  failNextRelevance = false;
  /** When set, the NEXT behavioral check reports a violation once. */
  failNextBehavioral = false;

  constructor(public delays: StubDelays = {}) {}

  scriptGeneration(...texts: string[]): void {
    this.scriptedGenerations.push(...texts);
  }

  reset(): void {
    this.calls = [];
    this.scriptedGenerations = [];
    this.failNextRelevance = false;
    this.failNextBehavioral = false;
  }

  callsByClass(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.calls) out[c.cls] = (out[c.cls] ?? 0) + 1;
    return out;
  }

  private classify(req: LLMRequest): CallClass {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    if (system.includes('Use Google Search to find specific, practical, varied meal and snack ideas')) {
      return 'search_food_ideas';
    }
    const systemLower = system.toLowerCase();
    for (const [cls, marker] of MARKERS) {
      if (systemLower.includes(marker.toLowerCase())) return cls;
    }
    // Default: a generation call. Both the orchestrator and the ai.service
    // direct path send the persona/user-context system prompt, whose exact
    // head varies — anything unmatched above is response generation.
    return 'generation';
  }

  private defaultGeneration(userText: string): string {
    const word = (userText.match(/[a-zA-Z]{4,}/g) ?? ['that'])[0]!.toLowerCase();
    return `That makes sense, and the ${word} part is worth paying attention to. Keep meals small and protein first today, and let me know how you feel this evening.`;
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const cls = this.classify(req);
    const startedAt = Date.now();
    const delay = this.delays[cls] ?? this.delays['default'] ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    const userText = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    let text: string;

    switch (cls) {
      case 'planner': {
        // Heuristic approximation of the production planner's decisions so
        // tool execution paths run deterministically.
        const t = userText.toLowerCase();
        let decision: { intent: string; needsTools: boolean; toolCalls: Array<{ name: string; args: Record<string, unknown> }> };
        const weightMatch = t.match(/\b(?:weigh(?:ed)?|weight is|i'?m at)\s+(\d{2,3})(?:\.\d+)?\s*(?:lbs|pounds)?\b/);
        if (/\b(ate|had|eating|drank|just had|for (breakfast|lunch|dinner))\b/.test(t) && !/how (much|many)/.test(t)) {
          decision = { intent: 'log_food', needsTools: true, toolCalls: [{ name: 'log_food', args: { food: userText } }] };
        } else if (weightMatch) {
          decision = { intent: 'log_weight', needsTools: true, toolCalls: [{ name: 'log_weight', args: { weight_lbs: Number(weightMatch[1]) } }] };
        } else if (/\b(nauseous|nausea|constipated|constipation|dizzy|fatigued?|heartburn|diarrhea)\b/.test(t)) {
          decision = { intent: 'side_effect', needsTools: true, toolCalls: [{ name: 'log_side_effect', args: { effect: t.match(/nause|constipat|dizzy|fatigue|heartburn|diarrhea/)?.[0] ?? 'nausea' } }] };
        } else if (/how (much|many) (protein|calorie)/.test(t) || /protein (count|total|today)/.test(t)) {
          decision = { intent: 'chat', needsTools: true, toolCalls: [{ name: 'get_food_summary', args: {} }] };
        } else if (/\?\s*$/.test(userText.trim()) && /\b(why|what|how|when|should|can|does|is)\b/.test(t)) {
          decision = { intent: 'knowledge_lookup', needsTools: true, toolCalls: [{ name: 'knowledge_search', args: { query: userText } }] };
        } else {
          decision = { intent: 'chat', needsTools: false, toolCalls: [] };
        }
        text = JSON.stringify({ ...decision, rationale: 'stub-heuristic' });
        break;
      }
      case 'relevance_check':
        if (this.failNextRelevance) {
          this.failNextRelevance = false;
          text = JSON.stringify({ relevant: false, reason: 'stub-scripted failure' });
        } else {
          text = JSON.stringify({ relevant: true, reason: 'ok' });
        }
        break;
      case 'behavioral_guard':
        if (this.failNextBehavioral) {
          this.failNextBehavioral = false;
          text = JSON.stringify({ violations: [{ principle: 'answers the actual question', reason: 'stub-scripted' }] });
        } else {
          text = JSON.stringify({ violations: [] });
        }
        break;
      case 'critic':
        text = JSON.stringify({ grounding: 5, safety: 5, on_task: 5, tone: 5, issues: [] });
        break;
      case 'macro_estimate':
        text = JSON.stringify({ protein_g: 30, calories: 400 });
        break;
      case 'food_itemize': {
        // One item per comma/'and'-separated food in the description —
        // deterministic 20g/250kcal per item so totals are assertable.
        const items = userText.split(/,| and | with /i).map((s) => s.trim()).filter((s) => s.length > 1)
          .map((name) => ({ name: name.slice(0, 40), protein_g: 20, calories: 250 }));
        text = JSON.stringify({ items: items.length > 0 ? items : [{ name: userText.slice(0, 40), protein_g: 20, calories: 250 }], confidence: 'high' });
        break;
      }
      case 'food_decompose': {
        const items = userText.split(/,| and | with /i).map((s) => s.trim()).filter((s) => s.length > 1)
          .map((name) => ({ name: name.slice(0, 40), grams: 100 }));
        text = JSON.stringify({ items });
        break;
      }
      case 'fact_extractor': {
        const facts: Array<{ fact: string; category: string; confidence: string }> = [];
        const rememberMatch = userText.match(/\bremember\b[,:\s]*(?:that\s+)?(.{4,80})/i);
        if (rememberMatch) facts.push({ fact: rememberMatch[1]!.trim().replace(/[.?!]$/, ''), category: 'preference', confidence: 'high' });
        if (/night shift/i.test(userText)) facts.push({ fact: 'works night shifts', category: 'schedule', confidence: 'high' });
        text = JSON.stringify({ facts });
        break;
      }
      case 'user_memory_extract': {
        const mems: Array<{ content: string; kind: string; confidence: number }> = [];
        const userLine = userText.match(/USER:\s*(.*)/)?.[1] ?? '';
        const rememberMatch = userLine.match(/\bremember\b[,:\s]*(?:that\s+)?(.{4,80})/i);
        if (rememberMatch) mems.push({ content: rememberMatch[1]!.trim().replace(/[.?!]$/, ''), kind: 'preference', confidence: 0.9 });
        if (/night shift/i.test(userLine)) mems.push({ content: 'works night shifts', kind: 'context', confidence: 0.9 });
        text = JSON.stringify(mems);
        break;
      }
      case 'conversation_summary':
        text = 'User is on a GLP-1 medication and has been logging meals and asking about protein targets.';
        break;
      case 'memory_md_updater':
        text = '# Memory\n\n## Profile\nGLP-1 user.\n\n## Recent context\nLogged food today.\n\n## Open threads\nNone.';
        break;
      case 'search_food_ideas':
        text = JSON.stringify([
          { name: 'Greek yogurt with hemp seeds', protein_g: 18, why: 'small and protein dense' },
          { name: 'lentil soup', protein_g: 15, why: 'gentle on digestion' },
          { name: 'cottage cheese with berries', protein_g: 20, why: 'high protein, low volume' },
        ]);
        break;
      case 'food_question_direct':
        text = this.scriptedGenerations.shift()
          ?? 'Greek yogurt, eggs, cottage cheese, or a lentil soup would all sit well today. Small portions, protein first, and see how your stomach feels.';
        break;
      case 'emergency_fallback':
        text = 'I hear you. Tell me a bit more and we will sort it out together.';
        break;
      case 'generation':
      case 'unknown':
      default:
        text = this.scriptedGenerations.shift() ?? this.defaultGeneration(userText);
        break;
    }

    const call: RecordedCall = {
      seq: this.seq++,
      cls,
      model: req.model,
      startedAt,
      endedAt: Date.now(),
      promptChars: req.messages.reduce((s, m) => s + m.content.length, 0),
      maxOutputTokens: req.maxOutputTokens,
      disableThinking: req.disableThinking,
      systemHead: (req.messages.find((m) => m.role === 'system')?.content ?? '').slice(0, 80),
      userText: userText.slice(0, 120),
      responseText: text.slice(0, 200),
      fullText: req.messages.map((m) => `[${m.role}] ${m.content}`).join('\n').slice(0, 40_000),
    };
    this.calls.push(call);
    return { text, finishReason: 'stop' };
  }
}
