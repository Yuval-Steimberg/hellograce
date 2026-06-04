/**
 * Comprehensive latency test cases — one per category of user message
 * Grace can receive. Each case includes:
 *   - category: human-readable group name
 *   - id: unique identifier
 *   - message: the user input (or array if multi-message coalesce test)
 *   - expectedPath: which code path SHOULD handle this (fast_path /
 *     food_log_fast / query_fast / weight_log_fast / faq_cache /
 *     orchestrator_simple / orchestrator_complex / safety / scheduling /
 *     pause / image / voice)
 *   - latencyTargetMs: the FLOOR we expect the system to hit
 *   - latencyHardCapMs: above this is a failure
 *
 * The test runner replays each message through the full pipeline against
 * a running grace-api instance (default localhost:3001) and records the
 * end-to-end response time. The report lists per-category P50/P95 + any
 * cases that breach their hard cap.
 *
 * USAGE:
 *   pnpm --filter @grace/api latency-bench
 *   GRACE_API_URL=https://grace-api.fly.dev pnpm --filter @grace/api latency-bench
 *   LATENCY_FILTER=fast_path pnpm --filter @grace/api latency-bench
 */

export interface LatencyCase {
  category: string;
  id: string;
  message: string;
  expectedPath:
    | 'fast_path'
    | 'food_log_fast'
    | 'weight_log_fast'
    | 'query_fast'
    | 'faq_cache'
    | 'orchestrator_simple'
    | 'orchestrator_complex'
    | 'safety'
    | 'scheduling'
    | 'pause'
    | 'image'
    | 'voice'
    | 'rlhf';
  /** Reasonable expected end-to-end ms — what we want to see. */
  latencyTargetMs: number;
  /** Hard cap — over this is a regression. */
  latencyHardCapMs: number;
  /** Optional history to set up context (e.g. "What's my protein goal?" → "60g" before "Why?"). */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export const LATENCY_CASES: LatencyCase[] = [
  // ─── A. Greetings ────────────────────────────────────────────────────────
  { category: 'A. Greetings', id: 'hi', message: 'Hi', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },
  { category: 'A. Greetings', id: 'hey', message: 'Hey', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },
  { category: 'A. Greetings', id: 'good_morning', message: 'Good morning', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },
  { category: 'A. Greetings', id: 'hey_grace', message: 'Hey Grace', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },
  { category: 'A. Greetings', id: 'whats_up', message: "What's up", expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },

  // ─── B. Brief acks ────────────────────────────────────────────────────────
  { category: 'B. Brief acks', id: 'thanks', message: 'Thanks', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },
  { category: 'B. Brief acks', id: 'ok', message: 'ok', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },
  { category: 'B. Brief acks', id: 'got_it', message: 'Got it', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },
  { category: 'B. Brief acks', id: 'sounds_good', message: 'Sounds good', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },
  { category: 'B. Brief acks', id: 'cool', message: 'Cool', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },

  // ─── C. Brief feelings ────────────────────────────────────────────────────
  { category: 'C. Brief feelings', id: 'feeling_great', message: 'Feeling great', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },
  { category: 'C. Brief feelings', id: 'tired', message: 'tired', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },
  { category: 'C. Brief feelings', id: 'im_good', message: "I'm good", expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },

  // ─── D. Goodnight / farewell ─────────────────────────────────────────────
  { category: 'D. Goodnight/farewell', id: 'goodnight', message: 'Goodnight', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },
  { category: 'D. Goodnight/farewell', id: 'bye', message: 'Bye', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },
  { category: 'D. Goodnight/farewell', id: 'ttyl', message: 'ttyl', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },

  // ─── E. Food log (common foods) ──────────────────────────────────────────
  { category: 'E. Food log common', id: 'two_eggs', message: 'I ate 2 eggs', expectedPath: 'food_log_fast', latencyTargetMs: 500, latencyHardCapMs: 2000 },
  { category: 'E. Food log common', id: 'protein_shake', message: 'just had a protein shake', expectedPath: 'food_log_fast', latencyTargetMs: 500, latencyHardCapMs: 2000 },
  { category: 'E. Food log common', id: 'greek_yogurt', message: 'Greek yogurt', expectedPath: 'food_log_fast', latencyTargetMs: 500, latencyHardCapMs: 2000 },
  { category: 'E. Food log common', id: 'oatmeal', message: 'had oatmeal for breakfast', expectedPath: 'food_log_fast', latencyTargetMs: 500, latencyHardCapMs: 2000 },

  // ─── F. Food log (restaurant/brand) ──────────────────────────────────────
  { category: 'F. Food log brand', id: 'chipotle_bowl', message: 'Chipotle bowl with chicken', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 6000 },
  { category: 'F. Food log brand', id: 'starbucks_latte', message: 'Starbucks oat latte', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 6000 },

  // ─── G. Food log (compound) ──────────────────────────────────────────────
  { category: 'G. Food log compound', id: 'chicken_rice_salad', message: 'I had chicken, rice, and salad for lunch', expectedPath: 'orchestrator_simple', latencyTargetMs: 4000, latencyHardCapMs: 7000 },
  { category: 'G. Food log compound', id: 'multi_meal', message: 'For breakfast 2 eggs, for lunch chicken bowl', expectedPath: 'orchestrator_simple', latencyTargetMs: 4000, latencyHardCapMs: 7000 },

  // ─── J. Food question (recommendations) ──────────────────────────────────
  { category: 'J. Food question', id: 'breakfast_idea', message: 'What should I eat for breakfast?', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 5000 },
  { category: 'J. Food question', id: 'dinner_idea', message: 'What should I eat for dinner?', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 5000 },
  { category: 'J. Food question', id: 'snack_idea', message: 'any snack ideas?', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 5000 },

  // ─── K. Food question (protein content) ──────────────────────────────────
  { category: 'K. Food question protein', id: 'protein_in_eggs', message: 'How much protein is in 2 eggs?', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 5000 },

  // ─── N. Protein/calorie status queries ───────────────────────────────────
  { category: 'N. Status queries', id: 'how_much_protein_today', message: 'How much protein have I had today?', expectedPath: 'query_fast', latencyTargetMs: 500, latencyHardCapMs: 2000 },
  { category: 'N. Status queries', id: 'how_many_calories_today', message: 'How many calories have I had today?', expectedPath: 'query_fast', latencyTargetMs: 500, latencyHardCapMs: 2000 },
  { category: 'N. Status queries', id: 'did_i_overeat', message: 'Did I overeat?', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 5000 },

  // ─── O. Goal queries ─────────────────────────────────────────────────────
  { category: 'O. Goal queries', id: 'whats_my_protein_goal', message: "What's my protein goal?", expectedPath: 'query_fast', latencyTargetMs: 500, latencyHardCapMs: 2000 },
  { category: 'O. Goal queries', id: 'whats_my_calorie_goal', message: "What's my calorie goal?", expectedPath: 'query_fast', latencyTargetMs: 500, latencyHardCapMs: 2000 },
  { category: 'O. Goal queries', id: 'whats_my_weight_goal', message: "What's my weight goal?", expectedPath: 'query_fast', latencyTargetMs: 500, latencyHardCapMs: 2000 },

  // ─── P. Progress queries ─────────────────────────────────────────────────
  { category: 'P. Progress queries', id: 'how_am_i_doing', message: 'How am I doing today?', expectedPath: 'query_fast', latencyTargetMs: 500, latencyHardCapMs: 2000 },

  // ─── Q. Weight log ───────────────────────────────────────────────────────
  { category: 'Q. Weight log', id: 'weight_lbs', message: '185 lbs', expectedPath: 'weight_log_fast', latencyTargetMs: 500, latencyHardCapMs: 2000 },
  { category: 'Q. Weight log', id: 'weight_bare_number', message: '184', expectedPath: 'weight_log_fast', latencyTargetMs: 500, latencyHardCapMs: 2000 },
  { category: 'Q. Weight log', id: 'weight_with_decimal', message: '184.6', expectedPath: 'weight_log_fast', latencyTargetMs: 500, latencyHardCapMs: 2000 },

  // ─── R. Weight log compound ──────────────────────────────────────────────
  { category: 'R. Weight log compound', id: 'weight_and_dinner', message: 'I weigh 184 lbs, what should I eat for dinner?', expectedPath: 'orchestrator_simple', latencyTargetMs: 3500, latencyHardCapMs: 6000 },

  // ─── S. Mood log ─────────────────────────────────────────────────────────
  { category: 'S. Mood log', id: 'mood_7', message: 'mood 7', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 5000 },

  // ─── T. Exercise log ─────────────────────────────────────────────────────
  { category: 'T. Exercise log', id: 'walked_5k', message: 'just walked 5k', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 5000 },
  { category: 'T. Exercise log', id: 'gym_done', message: 'finished gym', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 5000 },

  // ─── U. Injection log ────────────────────────────────────────────────────
  { category: 'U. Injection log', id: 'took_shot', message: 'just took my shot', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 5000 },

  // ─── V. Side effects ─────────────────────────────────────────────────────
  { category: 'V. Side effects', id: 'nausea', message: "I'm feeling really nauseous today", expectedPath: 'orchestrator_complex', latencyTargetMs: 4000, latencyHardCapMs: 7000 },
  { category: 'V. Side effects', id: 'hair_loss', message: 'My hair is falling out', expectedPath: 'orchestrator_complex', latencyTargetMs: 4000, latencyHardCapMs: 7000 },
  { category: 'V. Side effects', id: 'plateau', message: "I've hit a plateau, it isn't working", expectedPath: 'orchestrator_complex', latencyTargetMs: 4000, latencyHardCapMs: 7000 },

  // ─── W. Medication question ──────────────────────────────────────────────
  { category: 'W. Medication', id: 'when_to_take_shot', message: 'When should I take my shot?', expectedPath: 'orchestrator_complex', latencyTargetMs: 4000, latencyHardCapMs: 7000 },
  { category: 'W. Medication', id: 'pen_storage', message: 'How do I store my pen?', expectedPath: 'orchestrator_complex', latencyTargetMs: 4000, latencyHardCapMs: 7000 },

  // ─── X. Emotional support ────────────────────────────────────────────────
  { category: 'X. Emotional', id: 'struggling', message: "I'm really struggling today", expectedPath: 'orchestrator_simple', latencyTargetMs: 3500, latencyHardCapMs: 6000 },
  { category: 'X. Emotional', id: 'want_to_quit', message: 'I want to quit this', expectedPath: 'orchestrator_simple', latencyTargetMs: 3500, latencyHardCapMs: 6000 },

  // ─── Y. Identity questions ───────────────────────────────────────────────
  { category: 'Y. Identity', id: 'are_you_real', message: 'Are you a real person?', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 5000 },
  { category: 'Y. Identity', id: 'who_are_you', message: 'Who are you?', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 5000 },

  // ─── Z. Reasoning request (requires history) ─────────────────────────────
  {
    category: 'Z. Reasoning request',
    id: 'why_protein_target',
    message: 'Why?',
    expectedPath: 'orchestrator_simple',
    latencyTargetMs: 3500,
    latencyHardCapMs: 6000,
    history: [
      { role: 'user', content: "What's my protein goal?" },
      { role: 'assistant', content: 'Your daily protein target is 60g.' },
    ],
  },
  {
    category: 'Z. Reasoning request',
    id: 'how_calculated',
    message: 'How did you calculate that?',
    expectedPath: 'orchestrator_simple',
    latencyTargetMs: 3500,
    latencyHardCapMs: 6000,
    history: [
      { role: 'user', content: 'Recommend protein for today' },
      { role: 'assistant', content: 'Try 60g of protein today to preserve muscle.' },
    ],
  },

  // ─── AA. Yes/No to an offer (requires history) ───────────────────────────
  {
    category: 'AA. Offer follow-through',
    id: 'yes_to_walkthrough',
    message: 'Yes',
    expectedPath: 'orchestrator_simple',
    latencyTargetMs: 3500,
    latencyHardCapMs: 6000,
    history: [
      { role: 'user', content: 'Why?' },
      { role: 'assistant', content: 'That comes from your weight and goal, want me to walk you through the numbers?' },
    ],
  },

  // ─── AB. Corrections ─────────────────────────────────────────────────────
  { category: 'AB. Corrections', id: 'actually_correction', message: 'Actually I lost 8 lbs not 18', expectedPath: 'orchestrator_simple', latencyTargetMs: 3000, latencyHardCapMs: 5000 },

  // ─── AD. Schedule changes ────────────────────────────────────────────────
  { category: 'AD. Schedule', id: 'text_me_less', message: 'text me less', expectedPath: 'scheduling', latencyTargetMs: 1000, latencyHardCapMs: 2000 },

  // ─── AE. Pause request ───────────────────────────────────────────────────
  { category: 'AE. Pause', id: 'pause', message: 'pause messages for a week', expectedPath: 'pause', latencyTargetMs: 1000, latencyHardCapMs: 2000 },

  // ─── AG. Appointment prep ────────────────────────────────────────────────
  { category: 'AG. Appointment prep', id: 'endo_prep', message: 'Help me write questions for my endo appointment next week', expectedPath: 'orchestrator_complex', latencyTargetMs: 5000, latencyHardCapMs: 8000 },

  // ─── AH. Knowledge questions ─────────────────────────────────────────────
  { category: 'AH. Knowledge', id: 'why_hair_loss', message: 'What causes hair loss on Ozempic?', expectedPath: 'orchestrator_complex', latencyTargetMs: 5000, latencyHardCapMs: 8000 },
  { category: 'AH. Knowledge', id: 'mechanism', message: 'How does GLP-1 actually work?', expectedPath: 'orchestrator_complex', latencyTargetMs: 5000, latencyHardCapMs: 8000 },

  // ─── AI. Social situations ───────────────────────────────────────────────
  { category: 'AI. Social', id: 'wedding', message: "I have a wedding this weekend, any tips for the food?", expectedPath: 'orchestrator_simple', latencyTargetMs: 4000, latencyHardCapMs: 6000 },
  { category: 'AI. Social', id: 'restaurant', message: 'What should I order at a restaurant tonight?', expectedPath: 'orchestrator_simple', latencyTargetMs: 4000, latencyHardCapMs: 6000 },

  // ─── AR. Hydration / beverages ───────────────────────────────────────────
  { category: 'AR. Beverages', id: 'coffee_ok', message: 'Is coffee ok on Ozempic?', expectedPath: 'orchestrator_complex', latencyTargetMs: 4000, latencyHardCapMs: 7000 },
  { category: 'AR. Beverages', id: 'alcohol', message: 'Can I drink wine?', expectedPath: 'orchestrator_complex', latencyTargetMs: 4000, latencyHardCapMs: 7000 },

  // ─── AO. Gibberish ───────────────────────────────────────────────────────
  { category: 'AO. Gibberish', id: 'random_chars', message: 'asdfgh', expectedPath: 'orchestrator_simple', latencyTargetMs: 2000, latencyHardCapMs: 4000 },
  { category: 'AO. Gibberish', id: 'just_emoji', message: '👍', expectedPath: 'fast_path', latencyTargetMs: 300, latencyHardCapMs: 1500 },

  // ─── AQ. Crisis (must short-circuit) ────────────────────────────────────
  { category: 'AQ. Crisis', id: 'chest_pain', message: "I'm having chest pain", expectedPath: 'safety', latencyTargetMs: 200, latencyHardCapMs: 1000 },
  { category: 'AQ. Crisis', id: 'self_harm', message: 'I want to hurt myself', expectedPath: 'safety', latencyTargetMs: 200, latencyHardCapMs: 1000 },
];

export function casesByCategory(): Record<string, LatencyCase[]> {
  const byCat: Record<string, LatencyCase[]> = {};
  for (const c of LATENCY_CASES) {
    if (!byCat[c.category]) byCat[c.category] = [];
    byCat[c.category]!.push(c);
  }
  return byCat;
}
