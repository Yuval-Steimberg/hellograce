// LLM-powered semantic relevance check — the third layer of topic drift detection.
// Fires after keyword overlap and Jaccard duplication checks in the orchestrator.
// A fast Gemini 2.0 Flash call verifies the response actually answers the user's
// latest message, catching semantic mismatches that keyword heuristics miss.

import type { LLMProvider } from '@grace/shared';

export interface RelevanceVerdict {
  relevant: boolean;
  reason: string;
}

const RELEVANCE_SYSTEM = `You are a quality checker for a chatbot called Grace. Your ONLY job: does Grace's response answer the user's LATEST message?

Rules:
- "relevant" = true ONLY if the response directly addresses what the user just asked/said
- "relevant" = false if the response is about a DIFFERENT topic from the user's latest message (even if that topic was discussed earlier in the conversation)
- "relevant" = false if the response continues answering a PREVIOUS question instead of the new one
- "relevant" = false if the response opens by addressing the old topic before getting to the new one
- Short empathetic responses to emotional messages ARE relevant (user says "I feel tired" → "That's tough" is relevant)
- A greeting response to a greeting IS relevant

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
        model: 'gemini-2.0-flash',
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
