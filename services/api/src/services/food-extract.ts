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
import { macroSanityConfidence, type Confidence } from '../nutrition/macro-sanity.js';

/** Model for the structured extraction pass. flash-lite is markedly faster than
 *  flash for JSON classification; overridable/revertible via GEMINI_EXTRACT_MODEL. */
const EXTRACT_MODEL = process.env.GEMINI_EXTRACT_MODEL || 'gemini-2.5-flash-lite';

export interface ExtractedFoodItem {
  item: string;
  protein_g: number | null;
  calories: number | null;
  status: 'confirmed' | 'pending_portion';
  clarify_question: string | null;
  /** How trustworthy the estimate is (food_tracker idea): exact = from a label,
   *  high = a clearly-stated portion, medium = a typical-serving estimate, low =
   *  a rough guess (or a macro-sanity downgrade). Drives reply hedging. Null for
   *  pending items (nothing estimated yet). */
  confidence: Confidence | null;
  /** The portion phrase the estimate is for ("2 slices", "1 cup", "200g"), stored
   *  alongside the log so an edit/re-ask has the amount, not just the food name.
   *  Null when no amount was given. */
  serving_size: string | null;
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
  "items": [{"item": string, "protein_g": number|null, "calories": number|null, "status": "confirmed"|"pending_portion", "clarify_question": string|null, "confidence": "exact"|"high"|"medium"|"low"|null, "serving_size": string|null}],
  "edit_ref": string|null
}

Intent rules:
- "log": the user is reporting something they ate/drank. Each distinct food = its own item. If the portion is concrete (a number/unit/standard serving — "3 eggs", "4 oz chicken", "a cup of rice", "two slices", "a bowl of oatmeal"), status="confirmed" with realistic protein_g/calories. If a food is named but the portion is genuinely vague ("had pizza", "had a burger", "some tofu", "a bit of chicken", a bare restaurant), status="pending_portion", numbers null, AND clarify_question = ONE short friendly question for the portion. One pending item per vague food.
- A statement that ASSIGNS foods to meals is REPORTING what they ate today — intent="log" — even with NO "I ate/had" verb, as long as there's no question and no explicit future/planning word. Examples that ARE logs: "2 eggs for breakfast. For lunch chicken and rice" → log: eggs (confirmed, 2), chicken (pending), rice (pending). "oatmeal this morning, salad at lunch" → log. Treat "X for breakfast / for lunch / for dinner / this morning / at lunch" as eaten. It is ONLY planning (intent="none") when the message asks what they SHOULD eat, or uses an explicit future/planning marker ("I'm going to have", "thinking of", "planning to", "might have", "should I have", "what about").
- "edit": the user is correcting a prior meal ("that was only 1 slice", "actually 3 eggs not 2") OR supplying a portion for a pending item. edit_ref = short phrase identifying the prior/pending item. Put the corrected item in items[] with status="confirmed" and new numbers.
- "delete": the user wants to remove a prior meal ("remove the pizza", "I didn't actually eat that"). edit_ref = phrase identifying the item. items[] empty.
- "query": the user is ASKING about their diary/protein/calories ("what's my protein at?", "what did I eat today?"). items[] empty.
- "none": everything else.

Hard rules:
- NEVER invent items. Only foods literally named. Never add a food the user did not name (no "black coffee", no side dishes they didn't mention).
- SPLIT separate foods into their OWN items, each judged on its own portion. Foods joined by "with"/"and"/"plus"/", " are usually SEPARATE: "2 eggs with salad" → "2 eggs" (confirmed, ~12g) + "salad" (pending_portion); "chicken and rice" → chicken + rice; "salmon with potatoes and a salad" → salmon + potatoes + salad. Logging a known-portion food (the 2 eggs) is NOT blocked by an unknown-portion food next to it (the salad) — log the eggs, pend the salad. EXCEPTION: keep a SINGLE named dish as ONE item — do NOT split "ham and cheese sandwich", "peanut butter and jelly", "chicken salad", "mac and cheese", "rice and beans", "bacon and eggs" (a combined breakfast dish stays one item only if it reads as one dish; otherwise split).
- A bare meal-TIME or container word with NO named dish is NOT an item: "I had breakfast late", "a big lunch", "grabbed dinner", "had a snack" name WHEN/how much they ate, not WHAT — you don't know the food, so items=[] for that (intent="none" unless another part names a real food). Only "breakfast burrito", "chicken for lunch", etc. (an actual food) are items.
- A message can BOTH report eaten food AND ask a question. If the user says they ATE / HAD / DRANK / FINISHED / JUST HAD a food, LOG that food (intent="log", each distinct food its own item) EVEN IF the same message ALSO asks how much protein/calories it has, asks what to eat next or later, or asks anything else. Log what they actually ate; the questions are answered separately and are NEVER a reason to skip the log. Example: "I had salmon with potatoes and salad. How much protein is that, and what should I eat later?" → intent="log", items: salmon, potatoes, salad (portions pending if no amount given). The protein question and the "later" idea are handled by the reply, NOT logged. Another: "I'm going out to a restaurant tonight and don't know what to order. Today I only had a small yogurt and some crackers because I wasn't hungry. Can you give me order ideas and tell me what to avoid?" → intent="log", items: yogurt (pending_portion — "small" is a size, not an amount), crackers (pending_portion). A LOT of planning/question text around the food does NOT make it intent="none" — as long as they said they ATE/HAD something, log/pend it.
- Advice/planning about food NOT yet eaten is NOT logging: if the user asks what they SHOULD eat, what would be good, what to have later, whether a food is ok/good, or says they are thinking/planning/might have a food, that hypothetical food is intent="none". But this NEVER cancels logging a food they explicitly said they already ate in the SAME message. A bare food answer after Grace asked "what kind do you have in mind?" is planning, not intake → intent="none".
- Plain water / black coffee / plain tea / diet soda → intent="none".
- CONFIRMED requires a concrete portion: a number + unit/item ("3 eggs", "4 oz chicken", "half cup rice", "200g salmon", "two slices", "a cup of pasta"), OR an inherently single-serving item ("a banana", "an apple", "a slice of toast"). Then status="confirmed" with realistic protein_g/calories.
- A food named WITHOUT an amount ("had pasta", "ate chicken", "had a burger", "some rice", "a bit of tofu", a bare restaurant/cuisine) → status="pending_portion", numbers null, with a SHORT friendly clarify_question that suggests an easy ballpark ("roughly how much chicken — a palm-sized piece or so?"). ALWAYS ask for the portion when the amount is missing — do NOT silently assume a serving size. This is the default for any bare food mention.
- Standard portion references for CONFIRMED items: egg≈6g/70cal, slice bread≈3g/80cal, oz cooked chicken≈7g/45cal, cup greek yogurt≈17g/130cal, scoop whey≈24g/120cal, cup milk≈8g/120cal, oz cheese≈7g/110cal, tbsp peanut butter≈4g/95cal, cup cooked rice≈4g/200cal, cup cooked pasta≈8g/220cal, banana≈1g/105cal, cup berries≈1g/70cal. ROUNDING (Nudge rule): protein — if ≥5g round to the nearest 5g; if between 1g and 4g keep it as the integer (NEVER round a real protein value down to 0); only use 0 when the food genuinely has ~0g protein (water, black coffee, plain soda, hard candy). Calories: round to nearest 10.
- Each vague food is ONE pending item with its own clarify_question; the app combines multiple into a single friendly question. Never re-ask a pending item already resolved by this message.
- confidence (per CONFIRMED item — how trustworthy the estimate is): "exact" ONLY when the user gave a nutrition-label number ("this bar has 20g protein"); "high" for a clearly stated, standard portion of a well-known food ("3 eggs", "4 oz chicken"); "medium" for a normal typical-serving estimate; "low" for a rough guess. A pending_portion item has confidence null (nothing estimated yet).
- serving_size (per item): the portion phrase the numbers are for, exactly as it can be read back — "2 slices", "1 cup", "200g", "a palm-sized piece". Null when no amount was given (pending items are null).

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
      // Confidence: enum-clamp; a confirmed item with no/invalid value defaults to
      // 'medium' (a typical-serving estimate). Pending items carry null.
      const rawConf = ['exact', 'high', 'medium', 'low'].includes(it.confidence as string)
        ? (it.confidence as Confidence) : null;
      const serving_size = typeof it.serving_size === 'string' && it.serving_size.trim()
        ? it.serving_size.trim().slice(0, 64) : null;
      let confidence: Confidence | null = status === 'pending_portion' ? null : (rawConf ?? 'medium');
      // Deterministic macro-sanity: an internally-impossible estimate (protein
      // kcal > total kcal) is never trusted — downgrade to 'low' so the reply
      // hedges the number instead of presenting a hallucination as fact.
      if (confidence) confidence = macroSanityConfidence(protein_g, calories, confidence);
      return { item, protein_g, calories, status, clarify_question, confidence, serving_size };
    })
    .filter((x): x is ExtractedFoodItem => x !== null);

  const edit_ref = typeof obj.edit_ref === 'string' && obj.edit_ref.trim() ? obj.edit_ref.trim().slice(0, 200) : null;

  return { intent, items, edit_ref };
}

function pickSeeded<T>(arr: readonly T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return arr[Math.abs(h) % arr.length]!;
}

/** Strip a leading consumption phrase so a confirmation reads "2 eggs", not the
 *  raw "I ate 2 eggs" the user typed (prod 2026-07-08: "Logged I ate 2 eggs").
 *  Only removes an opening verb/meal frame; never touches the food itself. */
function cleanFoodLabel(s: string): string {
  const cleaned = (s ?? '')
    .trim()
    .replace(/^for\s+(?:breakfast|lunch|dinner|brunch|a\s+snack)\s*,?\s*/i, '')
    .replace(/^(?:i\s+)?(?:just\s+)?(?:ate|had|have|grabbed|made|got|finished|drank)\s+(?:some\s+|a\s+bit\s+of\s+)?/i, '')
    .trim();
  return cleaned.length >= 2 ? cleaned : (s ?? '').trim();
}

function humanList(items: string[]): string {
  const a = items.filter(Boolean);
  if (a.length === 0) return '';
  if (a.length === 1) return a[0]!;
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`;
}

/**
 * Build the warm, SHORT, deterministic food reply (confirmation and/or the one
 * portion question). Deterministic on purpose — it can never ramble into a
 * nutrition essay or summary dump, and never stalls. Varied by seed so it
 * doesn't read like a fixed template.
 */
export function formatFoodReply(opts: {
  loggedItems: string[];
  loggedProtein?: number | null;
  loggedCalories?: number | null;
  pendingFoods: string[];
  seed: string;
  /** When the logged estimate is low/medium confidence (food_tracker idea), the
   *  total is hedged so a rough guess is never presented as exact. */
  rough?: boolean;
}): string {
  const logged = humanList(opts.loggedItems.map(cleanFoodLabel));
  const pending = humanList(opts.pendingFoods.map(cleanFoodLabel));
  // A rough estimate is flagged honestly and offers an easy path to exact.
  const hedge = opts.rough ? ' — a rough estimate, tell me the portion if you want it exact' : '';
  const total =
    opts.loggedProtein != null && opts.loggedProtein > 0
      ? ` You're at about ${Math.round(opts.loggedProtein)}g protein${opts.loggedCalories != null && opts.loggedCalories > 0 ? ` and ${Math.round(opts.loggedCalories)} calories` : ''} today${hedge}.`
      : '';

  // Portion question only (nothing concrete to log yet).
  if (pending && !logged) {
    const openers = ['Sounds good', 'Nice', 'Got it', 'Love that'];
    const asks = [
      `roughly how much ${pending}? A ballpark — a cup, a handful, a couple — is perfect.`,
      `about how much ${pending} did you have? Even a rough amount (a cup, a palmful) lets me log it.`,
      `how much ${pending} would you say — a cup or so, a handful?`,
    ];
    return `${pickSeeded(openers, opts.seed)} — ${pickSeeded(asks, opts.seed + 'a')}`;
  }

  // Confirmation only — warm + varied opener, and about half the time a light,
  // friendly closer ("How was it?") so a food log feels like a friend, not a
  // receipt. Still fully deterministic (no LLM) so it can never invent a food or
  // a number — the anti-hallucination guarantee the food path depends on.
  if (logged && !pending) {
    const acks = [
      `Logged ${logged}.`,
      `Got it — ${logged} is in.`,
      `Nice, ${logged} logged.`,
      `Done — ${logged} logged.`,
      `Love it — ${logged} is in.`,
      `Yum, ${logged} logged.`,
      `Perfect — ${logged} is in.`,
    ];
    const closers = ['', '', '', ' How was it?', ' Hope it was good.', " How'd it hit the spot?"];
    return `${pickSeeded(acks, opts.seed)}${total}${pickSeeded(closers, opts.seed + 'c')}`;
  }

  // Logged some + still need a portion for the rest.
  if (logged && pending) {
    const acks = [`Logged ${logged}.`, `Got ${logged} down.`, `${logged} is in.`];
    const asks = [
      `For the ${pending}, roughly how much? A ballpark works.`,
      `About how much ${pending} — a cup, a handful?`,
    ];
    return `${pickSeeded(acks, opts.seed)}${total} ${pickSeeded(asks, opts.seed + 'b')}`;
  }

  return '';
}

/** Run the extraction LLM pass. Fails closed (intent="none") on any error so a
 *  food turn never crashes the reply. */
export async function extractFood(
  llm: LLMProvider,
  logger: Logger,
  userMessage: string,
  pendingItems: Array<{ item: string }>,
  // Optional model override. The unified (Nudge) path passes the STRONG model
  // (gemini-2.5-flash): Nudge runs its extractor on gemini-3-flash, and the weak
  // flash-lite default routinely mislabels a plainly-reported meal as `none`
  // ("I ate 2 eggs and chicken and rice" → nothing logged). Accuracy > latency
  // for the food log — the #1 customer complaint.
  modelOverride?: string,
): Promise<FoodExtraction> {
  try {
    const system = buildFoodExtractPrompt(pendingItems);
    const resp = await llm.generate({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMessage },
      ],
      // Structured JSON classification (not user-facing prose) → the faster
      // flash-lite is ideal. Latency-only; a bad/unavailable id falls back to
      // GEMINI_FALLBACK_MODEL via the provider's 404 handler, so extraction
      // never breaks. Revert with GEMINI_EXTRACT_MODEL=gemini-2.5-flash.
      model: modelOverride || EXTRACT_MODEL,
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
