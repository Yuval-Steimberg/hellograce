/**
 * 2026-06-05 production-failure regression suite.
 *
 * Every screenshot the user sent today maps to a specific code path
 * that broke. This file locks every fix in with a test so future
 * sessions can't accidentally re-introduce these regressions.
 *
 * Each test is a literal user message from a real WhatsApp screenshot,
 * with the minimum assertions needed to verify the fix.
 */

import { describe, it, expect } from 'vitest';
import { classifyMessage } from './classify.js';
import { enforceFormat, endsMidWord, trimToLastCompleteSentence } from './index.js';
import { checkContent } from './content-checker.js';

describe('production regressions — KNOWLEDGE routing', () => {
  // Screenshot 1, 23:26 + 23:40
  it('"How GLP can affect my muscles" routes to knowledge', () => {
    expect(classifyMessage('How GLP can affect my muscles').type).toBe('knowledge');
  });

  it('"How GLP-1 can affect my muscles" routes to knowledge', () => {
    expect(classifyMessage('How GLP-1 can affect my muscles').type).toBe('knowledge');
  });

  it('"How does GLP-1 work" routes to knowledge', () => {
    expect(classifyMessage('How does GLP-1 work').type).toBe('knowledge');
  });

  // Screenshot 4
  it('"Can drink alcohol" routes to knowledge', () => {
    expect(classifyMessage('Can drink alcohol').type).toBe('knowledge');
  });

  it('"Can I drink alcohol" routes to knowledge', () => {
    expect(classifyMessage('Can I drink alcohol').type).toBe('knowledge');
  });

  it('"Should I drink coffee" routes to knowledge', () => {
    expect(classifyMessage('Should I drink coffee').type).toBe('knowledge');
  });

  it('"how much water?" routes to knowledge', () => {
    expect(classifyMessage('how much water?').type).toBe('knowledge');
  });

  it('"What causes hair loss" routes to knowledge', () => {
    expect(classifyMessage('What causes hair loss').type).toBe('knowledge');
  });

  it('"Is constipation normal" routes to knowledge', () => {
    expect(classifyMessage('Is constipation normal').type).toBe('knowledge');
  });
});

describe('production regressions — content checker bans AI disclaimers', () => {
  // Screenshot 2 — "I cannot provide personalized dietary advice. My purpose is to..."
  it('bans "I cannot provide personalized dietary advice"', () => {
    const v = checkContent('I cannot provide personalized dietary advice. My purpose is to help with tasks like summarizing.', {});
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((x) => x.code === 'banned_phrase')).toBe(true);
  });

  it('bans "I cannot provide personalized medical advice"', () => {
    const v = checkContent('I cannot provide personalized medical advice about your injection schedule.', {});
    expect(v.some((x) => x.code === 'banned_phrase')).toBe(true);
  });

  it('bans "My purpose is to help with tasks"', () => {
    const v = checkContent('My purpose is to help with tasks like answering questions.', {});
    expect(v.some((x) => x.code === 'banned_phrase')).toBe(true);
  });

  it('bans "I am an AI and do not have access"', () => {
    const v = checkContent('I am an AI and do not have access to your medical history.', {});
    expect(v.some((x) => x.code === 'banned_phrase')).toBe(true);
  });

  it('bans "I am not equipped to"', () => {
    const v = checkContent('I am not equipped to give specific meal recommendations.', {});
    expect(v.some((x) => x.code === 'banned_phrase')).toBe(true);
  });

  it('bans "consult your doctor or registered dietitian"', () => {
    const v = checkContent('You should consult your doctor or a registered dietitian.', {});
    expect(v.some((x) => x.code === 'banned_phrase')).toBe(true);
  });
});

describe('production regressions — format enforcer numeric ranges', () => {
  // Screenshot 6 — "64, 80 ounces" came from "64–80 ounces"
  it('preserves "64-80 ounces" range form', () => {
    const r = enforceFormat('aiming for 64-80 ounces', {});
    expect(r.text).toMatch(/64-80\s+ounces/);
  });

  it('converts en-dash range to hyphen ("64–80" → "64-80")', () => {
    const r = enforceFormat('aiming for 64–80 ounces', {});
    expect(r.text).toMatch(/64-80\s+ounces/);
    expect(r.text).not.toMatch(/64,\s*80/);
  });

  it('converts em-dash range to hyphen ("64—80" → "64-80")', () => {
    const r = enforceFormat('aiming for 64—80 ounces', {});
    expect(r.text).toMatch(/64-80\s+ounces/);
  });

  it('still converts non-numeric em-dash to comma ("word — word" → "word, word")', () => {
    const r = enforceFormat('chicken — protein-dense, easy', {});
    expect(r.text).toMatch(/chicken,\s+protein-dense/);
  });
});

describe('production regressions — summary label colons survive', () => {
  // Screenshot — "Running total, 140g protein" came from "Running total: 140g protein"
  it('preserves "Running total:" colon', () => {
    const r = enforceFormat("Today you've had pizza. Running total: 140g protein, 2610 kcal.", {});
    expect(r.text).toMatch(/Running total:\s+140g/);
  });

  // Screenshot — "A few options Tofu stir-fry" came from "A few options: Tofu..."
  it('preserves "A few options:" colon', () => {
    const r = enforceFormat('A few options: Tofu stir-fry, Lentil dal, or Veggie omelet. Anything sound good?', {});
    expect(r.text).toMatch(/A few options:\s+Tofu/);
  });

  it('preserves "Some ideas:" colon', () => {
    const r = enforceFormat('Some ideas: Greek yogurt, cottage cheese, hard-boiled eggs.', {});
    expect(r.text).toMatch(/Some ideas:\s+Greek/);
  });
});

describe('production regressions — single bullet markers stripped', () => {
  // Screenshot — "* Satiety and Hunger Control GLP-1 medications..." in prose
  it('strips lone leading * before capitalized sentence', () => {
    const input = 'Your protein goal is 60 grams. * Satiety and Hunger Control. GLP-1 medications help.';
    const r = enforceFormat(input, {});
    expect(r.text).not.toMatch(/\*\s+Satiety/);
  });

  it('strips lone leading - before capitalized sentence', () => {
    const input = 'Important context. - Muscle preservation matters on GLP-1s.';
    const r = enforceFormat(input, {});
    expect(r.text).not.toMatch(/-\s+Muscle/);
  });

  it('does NOT strip when - is between words (numeric range)', () => {
    const input = 'aiming for 64-80 ounces';
    const r = enforceFormat(input, {});
    expect(r.text).toMatch(/64-80/);
  });

  it('does NOT strip when - is part of "GLP-1"', () => {
    const input = 'GLP-1 medications help.';
    const r = enforceFormat(input, {});
    expect(r.text).toMatch(/GLP-1/);
  });
});

describe('production regressions — endsMidWord catches truncation', () => {
  // Screenshot — "GLP-1 medications, while effective for weight loss, can "
  it('detects truncation after a comma-separated trailing space', () => {
    expect(endsMidWord('GLP-1 medications, while effective for weight loss, can ')).toBe(true);
  });

  it('detects truncation mid-word', () => {
    expect(endsMidWord('Try Greek yogurt with hemp see')).toBe(true);
  });

  it('does NOT flag a complete sentence as truncated', () => {
    expect(endsMidWord('Try Greek yogurt with hemp seeds.')).toBe(false);
  });

  it('trimToLastCompleteSentence trims back to last period', () => {
    const { trimmed, wasTrimmed } = trimToLastCompleteSentence(
      'Coffee can upset your stomach on a GLP-1. Try having it with food. It might also help to swit',
    );
    expect(wasTrimmed).toBe(true);
    expect(trimmed.endsWith('food.')).toBe(true);
  });
});

describe('production regressions — knowledge regex completeness', () => {
  // Specific GLP-1 topics that should always route to knowledge
  const knowledgeTopics = [
    'alcohol with my Ozempic',
    'caffeine on Wegovy',
    'sugar cravings disappeared',
    'how many carbs should I eat',
    'hydration on GLP-1',
    'sleep disturbances on Mounjaro',
    'exercise during nausea',
    'should I take vitamins',
    'supplements I should know about',
    'fiber intake on GLP-1',
    'is heartburn normal on Zepbound',
    'why am I so tired',
    'bloating after eating',
  ];

  for (const topic of knowledgeTopics) {
    it(`"${topic}" routes to knowledge`, () => {
      const result = classifyMessage(topic).type;
      // Some of these may also route to medication_question or food_question
      // which is acceptable — the test is that they DON'T go to general
      // (where the typed fallback ships unrelated content).
      expect(['knowledge', 'medication_question', 'food_question']).toContain(result);
    });
  }
});
