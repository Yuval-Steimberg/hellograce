/**
 * Nudge-style structured food extraction.
 *
 * One LLM pass turns a user message into a structured food-diary change:
 *   { intent: log|edit|delete|query|none, items: [...], edit_ref }
 *
 * The KEY to never looping on clarifications: PENDING items (a named food with
 * no portion, e.g. "had pizza") are tracked and passed back in on the next turn.
 * When the user then gives a portion ("2 slices"), the extractor returns
 * intent="edit" with edit_ref pointing at the pending item and a CONFIRMED
 * resolved item — so the portion answer RESOLVES the pending item instead of
 * starting a fresh clarification. This mirrors the competitor's food handling.
 *
 * Pure parsing/validation lives here so it can be unit-tested without an LLM.
 */
import type { LLMProvider } from '@grace/shared';
import type { Logger } from 'pino';

export interface ExtractedFoodItem {
  item: string;
  protein_g: number | null;
  calories: number | null;
  status: 'confirmed' | 'pending_portion';
  clarify_question: string | null;
}

export interface FoodExtraction {
  intent: 'log' | 'edit' | 'delete' | 'query' | 'none';
  items: ExtractedFoodItem[];
  edit_ref: string | null;
}

export const EMPTY_EXTRACTION: FoodExtraction = { intent: 'none', items: [], edit_ref: null };

/** Build the extraction system prompt, optionally seeded with the user's
 *  pending items so a portion answer resolves them (no re-ask loop). */
export function buildFoodExtractPrompt(pendingItems: Array<{ item: string }>): string {
  const pendingHint = pendingItems.length
    ? `\nPENDING ITEMS FROM EARLIER (waiting on a portion): ${pendingItems.map((p) => `"${p.item}"`).join(', ')}. If the user's message gives a portion/quantity for one of these, treat it as a clarification: set intent="edit", edit_ref=<the pending item phrase>, and put the resolved item in items[] with status="confirmed" and protein/calories numbers. Do NOT ask about it again.`
    : '';

  return `You parse ONE user message into structured food-diary changes.
Return STRICT JSON only:
{
  "intent": "log"|"edit"|"delete"|"query"|"none",
  "items": [{"item": string, "protein_g": number|null, "calories": number|null, "status": "confirmed"|"pending_portion", "clarify_question": string|null}],
  "edit_ref": string|null
}

Intent rules:
- "log": the user is reporting something they JUST ate/drank. Each distinct food = its own item. If the portion is concrete (a number/unit/standard serving — "3 eggs", "4 oz chicken", "a cup of rice", "two slices", "a bowl of oatmeal"), status="confirmed" with realistic protein_g/calories. If a food is named but the portion is genuinely vague ("had pizza", "had a burger", "some tofu", "a bit of chicken", a bare restaurant), status="pending_portion", numbers null, AND clarify_question = ONE short friendly question for the portion. One pending item per vague food.
- "edit": the user is correcting a prior meal ("that was only 1 slice", "actually 3 eggs not 2") OR supplying a portion for a pending item. edit_ref = short phrase identifying the prior/pending item. Put the corrected item in items[] with status="confirmed" and new numbers.
- "delete": the user wants to remove a prior meal ("remove the pizza", "I didn't actually eat that"). edit_ref = phrase identifying the item. items[] empty.
- "query": the user is ASKING about their diary/protein/calories ("what's my protein at?", "what did I eat today?"). items[] empty.
- "none": everything else.

Hard rules:
- NEVER invent items. Only foods literally named.
- Advice/planning is NOT logging: if the user asks what they SHOULD eat, what would be good, what to have later, whether a food is ok/good, or says they are thinking/planning/might have a food, intent="none". A bare food answer after Grace asked "what kind do you have in mind?" is planning, not intake → intent="none".
- Plain water / black coffee / plain tea / diet soda → intent="none".
- Prefer CONFIRMED with a sensible standard-serving estimate over pending when the food is specific enough to estimate (a named dish, a cut, a common item). Only use pending_portion for a genuinely bare category/restaurant with no way to estimate one serving.
- Standard portion references when confirming: egg≈6g/70cal, slice bread≈3g/80cal, oz cooked chicken≈7g/45cal, cup greek yogurt≈17g/130cal, scoop whey≈24g/120cal, cup milk≈8g/120cal, oz cheese≈7g/110cal, tbsp peanut butter≈4g/95cal, cup cooked rice≈4g/200cal, cup cooked pasta≈8g/220cal, banana≈1g/105cal, cup berries≈1g/70cal. Round protein to nearest 5g, calories to nearest 10.
- Ask AT MOST ONE clarify_question total, only for a genuinely-vague item, and never re-ask a pending item that is already resolved by this message.

Output ONLY the JSON object.${pendingHint}`;
}

/** Validate + normalize the model's JSON. Mirrors the competitor's clamps so a
 *  malformed/hallucinated field can never reach the diary. */
export function parseFoodExtraction(raw: string): FoodExtraction {
  let parsed: unknown;
  try {
    // Tolerate code fences / stray prose around the JSON object.
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    return { ...EMPTY_EXTRACTION };
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY_EXTRACTION };
  const obj = parsed as Record<string, unknown>;

  const intent = ['log', 'edit', 'delete', 'query', 'none'].includes(obj.intent as string)
    ? (obj.intent as FoodExtraction['intent'])
    : 'none';

  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items: ExtractedFoodItem[] = rawItems
    .map((raw): ExtractedFoodItem | null => {
      const it = (raw ?? {}) as Record<string, unknown>;
      const item = typeof it.item === 'string' && it.item.trim() ? it.item.trim().slice(0, 200) : null;
      if (!item) return null;
      const status: ExtractedFoodItem['status'] = it.status === 'pending_portion' ? 'pending_portion' : 'confirmed';
      let protein_g = typeof it.protein_g === 'number' && Number.isFinite(it.protein_g) && it.protein_g >= 0 && it.protein_g <= 300
        ? Math.round(it.protein_g) : null;
      let calories = typeof it.calories === 'number' && Number.isFinite(it.calories) && it.calories >= 0 && it.calories <= 5000
        ? Math.round(it.calories) : null;
      if (status === 'pending_portion') { protein_g = null; calories = null; }
      const clarify_question = typeof it.clarify_question === 'string' && it.clarify_question.trim()
        ? it.clarify_question.trim().slice(0, 240) : null;
      return { item, protein_g, calories, status, clarify_question };
    })
    .filter((x): x is ExtractedFoodItem => x !== null);

  const edit_ref = typeof obj.edit_ref === 'string' && obj.edit_ref.trim() ? obj.edit_ref.trim().slice(0, 200) : null;

  return { intent, items, edit_ref };
}

/** Run the extraction LLM pass. Fails closed (intent="none") on any error so a
 *  food turn never crashes the reply. */
export async function extractFood(
  llm: LLMProvider,
  logger: Logger,
  userMessage: string,
  pendingItems: Array<{ item: string }>,
): Promise<FoodExtraction> {
  try {
    const system = buildFoodExtractPrompt(pendingItems);
    const resp = await llm.generate({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.1,
      maxOutputTokens: 400,
      responseFormat: 'json',
      disableThinking: true,
    });
    const out = parseFoodExtraction(resp.text ?? '');
    logger.info(
      { intent: out.intent, items: out.items.length, pending: out.items.filter((i) => i.status === 'pending_portion').length },
      'food_extract.done',
    );
    return out;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'food_extract.error');
    return { ...EMPTY_EXTRACTION };
  }
}
