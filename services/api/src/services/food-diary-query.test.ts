import { describe, it, expect } from 'vitest';
import { isFoodDiaryQuery } from './ai.service.js';

/**
 * A food-diary QUESTION ("what have I eaten today?") must be recognized for ANY
 * phrasing so it's answered deterministically from the food log — never the LLM
 * reconstructing intake from conversation history. Prod IMG_6710: after a reset,
 * "Good morning, what I have eaten today?" was answered by dragging the pre-reset
 * shake+sandwich back up. This is a GENERAL detector, not a patch for one string.
 */
describe('isFoodDiaryQuery — recognizes every phrasing of "what have I eaten?"', () => {
  it('matches the many ways users ask what they have eaten today', () => {
    const yes = [
      'Good morning, what I have eaten today?',        // prod IMG_6710 (word order + greeting)
      'what have I eaten today?',
      'what did I eat today',
      'what did I eat so far',
      'what I ate today',
      'what have I had today?',
      'what have I logged today',
      'Hey Grace, what have I eaten so far today?',
      'so what did i eat today',
      'how much protein have I had today?',
      'how much protein did I eat today',
      'how many calories have I consumed today',
      'show my food today',
      "show me today's food",
      'summarize my day',
      'recap my meals today',
      "what's logged today?",
      'what is in my food log',
    ];
    for (const t of yes) expect(isFoodDiaryQuery(t), t).toBe(true);
  });

  it('does NOT fire for recommendations, plans, logs, or mutations', () => {
    const no = [
      'what should I eat today?',                       // recommendation
      'what can I eat for dinner',                       // recommendation
      'any ideas for breakfast?',                        // recommendation
      'help me plan what to eat before dinner',          // plan
      'I ate a chicken sandwich today',                  // a LOG, not a query
      'remove the pizza from today',                     // mutation
      'undo my last food',                               // mutation
      'what should I have for lunch, and what have I eaten so far?', // mixed → grounded path answers both
      'good morning!',                                   // greeting only
      'how are you today?',                              // small talk
    ];
    for (const t of no) expect(isFoodDiaryQuery(t), t).toBe(false);
  });
});
