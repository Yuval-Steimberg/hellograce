import type { LLMProvider } from '@grace/shared';
import type {
  ConversationEvaluation,
  EvalDimensionName,
  PreferencePair,
  SimulatedConversation,
} from './types.js';

export async function generatePreferencePairs(
  llm: LLMProvider,
  conversations: SimulatedConversation[],
  evaluations: ConversationEvaluation[],
): Promise<PreferencePair[]> {
  const pairs: PreferencePair[] = [];
  const evalMap = new Map(evaluations.map((e) => [e.conversationId, e]));

  for (const conv of conversations) {
    const evaluation = evalMap.get(conv.id);
    if (!evaluation) continue;

    for (const turnEval of evaluation.turnEvaluations) {
      if (turnEval.passed || turnEval.overallScore >= 4) continue;

      if (turnEval.dimensions.length === 0) continue;
      const worstDim = turnEval.dimensions.reduce(
        (worst, d) => (d.score < worst.score ? d : worst),
        turnEval.dimensions[0]!,
      );
      if (worstDim.score >= 3) continue;

      const turnIdx = turnEval.turnIndex;
      const historyTurns = conv.turns.slice(0, turnIdx * 2);
      const context = historyTurns
        .map((t) => `${t.role === 'user' ? 'User' : 'Grace'}: ${t.text}`)
        .join('\n');

      const improved = await generateImprovedResponse(
        llm,
        context,
        turnEval.userMessage,
        turnEval.graceResponse,
        worstDim.name,
        worstDim.reasoning,
        turnEval.suggestions,
      );

      if (improved && improved !== turnEval.graceResponse) {
        pairs.push({
          id: `pref_${conv.id}_t${turnIdx}_${Date.now()}`,
          conversationId: conv.id,
          turnIndex: turnIdx,
          context,
          userMessage: turnEval.userMessage,
          chosen: improved,
          rejected: turnEval.graceResponse,
          chosenScore: Math.min(5, turnEval.overallScore + 1.5),
          rejectedScore: turnEval.overallScore,
          dimension: worstDim.name,
          reasoning: `Original scored ${worstDim.score}/5 on ${worstDim.name}: ${worstDim.reasoning}`,
        });
      }
    }
  }

  return pairs;
}

async function generateImprovedResponse(
  llm: LLMProvider,
  context: string,
  userMessage: string,
  originalResponse: string,
  weakDimension: EvalDimensionName,
  weakReason: string,
  suggestions: string[],
): Promise<string | null> {
  const prompt = `You are Grace, a warm WhatsApp companion for GLP-1 medication users.

${context ? `CONVERSATION SO FAR:\n${context}\n` : ''}
USER'S LATEST MESSAGE:
${userMessage}

ORIGINAL RESPONSE (scored poorly):
${originalResponse}

WHAT WENT WRONG:
- Weak dimension: ${weakDimension}
- Reason: ${weakReason}
${suggestions.length > 0 ? `- Suggestions: ${suggestions.join('; ')}` : ''}

Write a BETTER response that fixes the identified weakness while following Grace's rules:
- Respond to the CURRENT message first
- Brief for brief messages, detailed only when needed
- Warm but not patronizing
- No question marks by default
- Never use the user's name
- Never suggest disliked foods
- Sound like a real person texting, not a corporate chatbot

Output ONLY the improved response text. No quotes, no labels, no explanation.`;

  try {
    const resp = await llm.generate({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      maxOutputTokens: 500,
    });
    return resp.text.trim();
  } catch {
    return null;
  }
}
