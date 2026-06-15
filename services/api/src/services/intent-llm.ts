/**
 * Gemini semantic intent classifier (2026-06-15).
 *
 * The deterministic classifier (classify.ts) is fast and handles the common
 * phrasings, but it lands ambiguous / unusual wordings in 'general', where they
 * get a generic fallback (production: "What I should do for dinner" → a symptom
 * blurb). This module asks Gemini to read the MEANING of such a message and
 * return a structured intent, so routing follows intent, not exact words.
 *
 * Used as a FALLBACK — only when the deterministic classifier returns 'general'
 * (or otherwise can't place the message). That keeps greetings, logs, and clear
 * questions on the ~150ms deterministic path, and pays the ~1s Gemini cost only
 * for the messages that would otherwise be misrouted. Fails safe: any error or
 * unparseable output returns null and the caller keeps the deterministic intent.
 */

import type { LLMProvider } from '@grace/shared';
import type { Logger } from 'pino';

export interface LLMIntentResult {
  primary_intent: string;
  requires_food_recommendation: boolean;
  requires_food_logging: boolean;
  requires_medical_triage: boolean;
  confidence: number;
  clarification_needed: boolean;
  /** Mapped to the app's internal MessageType, or null if it doesn't map. */
  mappedType: string | null;
}

const SYSTEM_PROMPT = `You classify the user's LATEST message to a GLP-1 nutrition coach. Read the MEANING, not keywords — typos, shorthand, and unusual phrasing must still classify correctly.

Output ONLY a JSON object, no prose:
{"primary_intent":"<one of: food_recommendation, food_logging, food_question, symptom, medication, progress, motivation, goal_update, settings, reminder, knowledge, greeting, other>","requires_food_recommendation":<bool>,"requires_food_logging":<bool>,"requires_medical_triage":<bool>,"confidence":<0..1>,"clarification_needed":<bool>}

Guidance:
- Asking what to eat / for ideas / "what should I do for dinner" / "dinner ideas" / "not sure what to make" / "hungry, suggestions?" → food_recommendation.
- Reporting food eaten ("I had/ate/drank X", "just finished Y") → food_logging.
- A nutrition fact question ("how much protein in eggs?") → food_question.
- Physical symptoms (nausea, tired, dizzy, constipated) → symptom (requires_medical_triage only if severe/red-flag).
- Dose/timing/storage of the medication → medication.
- Weight/progress check → progress. Settings/reminders → settings/reminder.
Be decisive; set confidence honestly.`;

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
}

/** Map Gemini's primary_intent to the app's internal MessageType strings. */
export function mapLLMIntent(intent: string, flags: { food_rec?: boolean; food_log?: boolean }): string | null {
  switch (intent) {
    case 'food_recommendation': return 'food_question';
    case 'food_question': return 'food_question';
    case 'food_logging': return 'food_log';
    case 'symptom': return 'knowledge';
    case 'medication': return 'medication_question';
    case 'progress': return 'knowledge';
    case 'motivation': return 'emotional';
    case 'goal_update': return 'scheduling';
    case 'settings': return 'scheduling';
    case 'reminder': return 'scheduling';
    case 'knowledge': return 'knowledge';
    default:
      // Fall back to the boolean flags when the label is 'other'/unknown.
      if (flags.food_rec) return 'food_question';
      if (flags.food_log) return 'food_log';
      return null;
  }
}

export async function classifyIntentLLM(
  llm: LLMProvider,
  logger: Logger,
  text: string,
  lastAssistant?: string,
): Promise<LLMIntentResult | null> {
  try {
    const userBlock =
      (lastAssistant ? `Previous assistant message: "${lastAssistant.slice(0, 160)}"\n` : '') +
      `User's latest message: "${text.slice(0, 300)}"`;
    const resp = await llm.generate({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userBlock },
      ],
      temperature: 0,
      maxOutputTokens: 160,
      model: 'gemini-2.0-flash',
      disableThinking: true,
    });
    const json = extractJson(resp.text ?? '');
    if (!json) return null;
    const primary = typeof json['primary_intent'] === 'string' ? (json['primary_intent'] as string) : 'other';
    const food_rec = json['requires_food_recommendation'] === true;
    const food_log = json['requires_food_logging'] === true;
    const result: LLMIntentResult = {
      primary_intent: primary,
      requires_food_recommendation: food_rec,
      requires_food_logging: food_log,
      requires_medical_triage: json['requires_medical_triage'] === true,
      confidence: typeof json['confidence'] === 'number' ? (json['confidence'] as number) : 0.5,
      clarification_needed: json['clarification_needed'] === true,
      mappedType: mapLLMIntent(primary, { food_rec, food_log }),
    };
    logger.info({ primary: result.primary_intent, mapped: result.mappedType, confidence: result.confidence }, 'ai.intent_llm.classified');
    return result;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ai.intent_llm.error');
    return null;
  }
}
