// LLM-powered semantic relevance check — the third layer of topic drift detection.
// Fires after keyword overlap and Jaccard duplication checks in the orchestrator.
// A fast Gemini 2.0 Flash call verifies the response actually answers the user's
// latest message, catching semantic mismatches that keyword heuristics miss.

import type { LLMProvider } from '@grace/shared';

export interface RelevanceVerdict {
  relevant: boolean;
  reason: string;
}

const RELEVANCE_SYSTEM = `You are a quality checker for a chatbot called Grace. Your ONLY job: does Grace's response actually ANSWER the user's LATEST message?

A response is "relevant" ONLY if it directly addresses what the user asked OR what the user is concerned about.

Mark "relevant": false if:
- The response is about a DIFFERENT topic than what the user asked
- The response continues a PREVIOUS topic instead of answering the new one
- The user asked a question (or multiple questions) and the response does NOT answer them
- The response is empty acknowledgment / congratulation / praise that ignores the actual concern
  Example: User says "I lost 18 pounds but I feel flabby, am I losing muscle?" → Response says "Great that you achieved your weight loss goal! That's an accomplishment." → NOT RELEVANT (ignores the muscle question and the concern about feeling flabby)
- The response opens by addressing the wrong concern (e.g. user has a worry, response gives praise)

Mark "relevant": true if:
- Short empathetic responses to emotional messages ("I feel tired" → "That's tough")
- A greeting response to a greeting
- An answer that addresses the user's actual concern even if briefly

The KEY question to ask yourself: "If a friend got this reply to their question, would they feel heard and informed, or would they feel ignored?"

Return ONLY a JSON object. No prose, no markdown fences.
{"relevant": true/false, "reason": "<one sentence explaining why>"}`;

export class RelevanceChecker {
  constructor(private llm: LLMProvider) {}

  async check(userMessage: string, graceResponse: string, lastGraceMessage?: string): Promise<RelevanceVerdict> {
    const context = lastGraceMessage
      ? `GRACE'S PREVIOUS MESSAGE (for context — this is the OLD response, already sent):\n${lastGraceMessage.slice(0, 200)}\n\n`
      : '';

    const prompt =
      `${context}USER'S NEW MESSAGE (this is what Grace must answer):\n${userMessage}\n\nGRACE'S NEW RESPONSE (check this):\n${graceResponse}`;

    try {
      const resp = await this.llm.generate({
        messages: [
          { role: 'system', content: RELEVANCE_SYSTEM },
          { role: 'user', content: prompt },
        ],
        temperature: 0.0,
        maxOutputTokens: 150,
        responseFormat: 'json',
        // 2026-06-03 revert: lite was returning false positives on food_question
        // responses ("relevance_check_failed" on a clearly-on-topic dinner reply
        // → forced a 2.7s regen). Keeping relevance on gemini-2.5-flash — the
        // ~250ms latency cost is worth the accuracy. behavioral-guard stays on
        // lite because it's strict-match semantics (banned phrases / preambles).
        model: 'gemini-2.5-flash',
        disableThinking: true,
      });

      const cleaned = resp.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
      const parsed = JSON.parse(cleaned) as { relevant?: boolean; reason?: string };
      return {
        relevant: parsed.relevant !== false,
        reason: parsed.reason ?? '',
      };
    } catch {
      return { relevant: true, reason: 'check_failed' };
    }
  }
}
