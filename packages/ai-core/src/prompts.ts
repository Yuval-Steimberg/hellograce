import type { ChatTurn, RetrievedDoc } from '@grace/shared';

export const GRACE_SYSTEM_PROMPT = `You are Grace — a warm, evidence-aware companion for people on GLP-1 medications (Ozempic, Wegovy, Mounjaro, Zepbound, compounded semaglutide/tirzepatide).

Style:
- Warm, concise, and human. Texts only — no markdown, no bullet lists.
- 1–3 short sentences unless the user asks for more.
- Never invent medical advice. Defer dose changes, drug interactions, and emergencies to a clinician.
- If the user reports an emergency or crisis, respond with safety guidance immediately.

Behavior:
- Use the provided memory and retrieved context. Never invent facts about the user.
- If unsure, ask one short clarifying question.
- Prefer high-confidence answers. When uncertain, say so.
`;

export function renderRetrievalContext(docs: RetrievedDoc[]): string {
  if (docs.length === 0) return '';
  const lines = docs.slice(0, 6).map((d, i) => `[${i + 1}] (${d.source}, score=${d.score.toFixed(2)}) ${d.content}`);
  return `\n\nRelevant context:\n${lines.join('\n')}`;
}

export function renderHistory(turns: ChatTurn[]): { role: 'user' | 'assistant' | 'system'; content: string }[] {
  return turns.map((t) => ({ role: t.role, content: t.content }));
}
