/**
 * Nudge's post-generation relevance judge + advice/planning guard, ported
 * faithfully (2026-07-04) from handle-inbound-sms/index.ts.
 *
 * Nudge's real handler is NOT "one call, no verifiers" (that header comment is
 * aspirational): it runs ONE relevance judge on the drafted reply and, if the
 * reply changed the subject / answered an older message instead of the latest,
 * regenerates once with a focused override. This is what stops the "user
 * reports a meal, Grace replies about the earlier snack question" bleed. It also
 * runs a deterministic advice/planning guard so a planning turn ("what should I
 * eat", or a bare "salmon" after Grace asked what she has in mind) is never
 * logged as food.
 */

import type { LLMProvider } from '@grace/shared';
import type { Logger } from 'pino';

export interface RelevanceTurn { role: string; content: string }

/**
 * Strict judge: does the reply respond ONLY to the user's latest message? NO if
 * it changes subject, ignores the point, answers an older message, or answers
 * both the latest and an older unrelated message. Fails OPEN (true) on any error
 * so a judge outage never blocks a reply. Ported from Nudge's
 * judgeReplyAddressesMessage.
 */
export async function judgeReplyAddressesMessage(
  llm: LLMProvider,
  logger: Logger,
  userMessage: string,
  reply: string,
): Promise<boolean> {
  const prompt =
    `You are a strict judge. A user texted this message:\n` +
    `<<<USER_MESSAGE\n${userMessage}\nUSER_MESSAGE>>>\n\n` +
    `The assistant drafted this reply:\n` +
    `<<<REPLY\n${reply}\nREPLY>>>\n\n` +
    `Does the reply respond ONLY to what the user just said - answering their question, ` +
    `acknowledging what they shared, or addressing their request? It does NOT need to repeat ` +
    `the question, and small friendly additions are fine. But if the reply changes the subject, ` +
    `ignores the user's actual point, replies to a different older message, OR answers both ` +
    `the latest message and an older unrelated message, answer NO.\n\n` +
    `Reply with exactly one word: YES or NO.`;
  try {
    const resp = await Promise.race([
      llm.generate({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        maxOutputTokens: 16,
        disableThinking: true,
        skipCache: true,
      }),
      new Promise<{ text: string }>((r) => setTimeout(() => r({ text: 'YES' }), 8000)),
    ]);
    const out = (resp.text ?? '').trim().toUpperCase();
    return !out.startsWith('N');
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'nudge_relevance.judge_failed');
    return true; // fail open
  }
}

/**
 * Deterministic advice/planning detector — ported verbatim from Nudge's
 * isMealAdviceOrPlanningTurn. True when food is being DISCUSSED (what should I
 * eat / is X good / a bare "salmon" after Grace asked what she has in mind), NOT
 * reported as eaten. Used to strip a food extract so planning never logs.
 */
export function isMealAdviceOrPlanningTurn(userMessage: string, history: RelevanceTurn[]): boolean {
  const text = (userMessage ?? '').toLowerCase().trim();
  if (!text) return false;

  const asksAdvice =
    /\b(what should i|what can i|what would be good|what(?:'s| is) good|any ideas|ideas for|recommend|suggest|what to eat|what i should eat|should i (?:eat|have|order)|can i (?:eat|have|order)|could i (?:eat|have|order)|is .{1,40}\b(?:good|ok|okay|fine)|would .{1,40}\bbe (?:good|ok|okay|fine)|plan to eat|planning to eat|thinking about|thinking of|might have|maybe have)\b/i.test(text) ||
    /\b(what for|what should i have for|what can i have for|what would be good for)\s+(breakfast|lunch|dinner|snack)\b/i.test(text) ||
    /\b(breakfast|lunch|dinner|snack)\s+(tomorrow|later|tonight)\b/i.test(text) ||
    (/\?$/.test(text) && /\b(good|ok|okay|fine|protein|meal|snack|breakfast|lunch|dinner|eat|have|order)\b/i.test(text));

  const reportsIntake =
    /\b(i\s+)?(just\s+)?(had|ate|drank|finished)\b/i.test(text) ||
    (/\b(for breakfast|for lunch|for dinner|as a snack)\b/i.test(text) && !/\b(tomorrow|later|tonight|should|can|could|would|thinking|planning|plan|might|maybe)\b/i.test(text));
  if (asksAdvice && !reportsIntake) return true;

  const compactFoodAnswer =
    text.length <= 60 &&
    !/[?]/.test(text) &&
    !/\b(had|ate|drank|finished|breakfast|lunch|dinner|snack|oz|ounce|ounces|cup|cups|gram|grams|slice|slices|piece|pieces|serving|servings)\b/i.test(text) &&
    /^[a-z][a-z\s'&-]{1,58}$/.test(text);
  if (!compactFoodAnswer) return false;

  const lastAssistant = [...history].reverse().find((t) => t.role === 'assistant')?.content.toLowerCase() || '';
  const lastUser = [...history].reverse().find((t) => t.role === 'user')?.content.toLowerCase() || '';
  const assistantWasPlanning =
    /\b(in mind|specific kind|what kind|which kind|what sounds good|what are you thinking|what protein|meal idea|for lunch tomorrow|for dinner tomorrow|for breakfast tomorrow)\b/i.test(lastAssistant) &&
    !/\b(how much|roughly how much|did you eat|portion|logged|log it|diary)\b/i.test(lastAssistant);
  const previousUserWasPlanning =
    /\b(what should i|what can i|what would be good|is .{1,40}\b(?:good|ok|okay|fine)|should i (?:eat|have|order)|thinking about|planning|plan to eat|what for\s+(breakfast|lunch|dinner|snack))\b/i.test(lastUser) ||
    (/\?$/.test(lastUser) && /\b(good|ok|okay|fine|protein|meal|snack|breakfast|lunch|dinner|eat|have|order)\b/i.test(lastUser));

  return assistantWasPlanning || previousUserWasPlanning;
}
