import { describe, it, expect } from 'vitest';
import { tryFastPath } from './fast-path.js';

const USER = '+15551234567';

describe('tryFastPath — greeting prefix + typo normalization (2026-06-01 fix)', () => {
  it('matches "Morning, feeling good" (greeting prefix + brief_positive)', () => {
    const result = tryFastPath('Morning, feeling good', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('brief_positive');
  });

  it('matches "Morning, felling good" (typo: felling → feeling)', () => {
    // Exact production failure: this missed fast-path → full LLM → 6-sentence
    // response that surfaced stale "40g" context from a previous day.
    const result = tryFastPath('Morning, felling good', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('brief_positive');
  });

  it('matches "Good morning, feeling great"', () => {
    const result = tryFastPath('Good morning, feeling great', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('brief_positive');
  });

  it('matches "Evening, doing good"', () => {
    const result = tryFastPath('Evening, doing good', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('brief_positive');
  });

  it('matches "Good morning. Feeling tired" → brief_negative (greeting + tired)', () => {
    const result = tryFastPath('Good morning. Feeling tired', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('brief_negative');
  });

  it('still matches plain "Morning" → greeting (no positive suffix)', () => {
    const result = tryFastPath('Morning', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('greeting');
  });

  it('still matches plain "feeling good" without a greeting prefix', () => {
    const result = tryFastPath('feeling good', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('brief_positive');
  });

  it('does NOT match medical or food-related messages even with greeting prefix', () => {
    // The NEVER_FAST_PATH_RE keyword guard must still apply after normalization.
    expect(tryFastPath('Morning, feeling nauseous', USER)).toBeNull();
    expect(tryFastPath('Morning, I had two eggs for breakfast', USER)).toBeNull();
    expect(tryFastPath('Good morning, my injection is due today', USER)).toBeNull();
  });

  it('does NOT match a message ending with a question mark', () => {
    expect(tryFastPath('Morning, feeling good?', USER)).toBeNull();
  });
});

describe('non_english fast-path (2026-06-06 — coverage audit)', () => {
  const USER = '+15551234567';

  it('Spanish "hola" → non_english reply', () => {
    const r = tryFastPath('hola', USER);
    expect(r).not.toBeNull();
    expect(r?.category).toBe('non_english');
    expect(r?.text).toMatch(/english/i);
  });

  it('French "bonjour" → non_english reply', () => {
    const r = tryFastPath('bonjour', USER);
    expect(r?.category).toBe('non_english');
  });

  it('Hebrew "שלום" → non_english reply', () => {
    const r = tryFastPath('שלום', USER);
    expect(r?.category).toBe('non_english');
  });

  it('Arabic "مرحبا" → non_english reply', () => {
    const r = tryFastPath('مرحبا', USER);
    expect(r?.category).toBe('non_english');
  });

  it('Russian Cyrillic "привет" → non_english reply', () => {
    const r = tryFastPath('привет', USER);
    expect(r?.category).toBe('non_english');
  });

  it('Hebrew distress phrase ("כאב בחזה") BYPASSES non_english fast-path', () => {
    // Critical safety check: a Hebrew chest-pain message must NOT receive
    // a "could you try in English" reply — it must fall through so the
    // orchestrator + safety pipeline runs.
    const r = tryFastPath('כאב בחזה', USER);
    expect(r).toBeNull();
  });

  it('Spanish distress phrase ("dolor en el pecho") BYPASSES non_english fast-path', () => {
    const r = tryFastPath('dolor en el pecho', USER);
    expect(r).toBeNull();
  });

  it('English "I had eggs" is UNAFFECTED by the non_english check', () => {
    const r = tryFastPath('I had eggs', USER);
    // Either matches another fast-path category or returns null — but never
    // 'non_english'.
    if (r) expect(r.category).not.toBe('non_english');
  });

  it('English with emoji "Thanks 🤍" is UNAFFECTED', () => {
    const r = tryFastPath('Thanks 🤍', USER);
    if (r) expect(r.category).not.toBe('non_english');
  });

  it('Accented English ("café") does NOT trigger non_english', () => {
    // The 40% non-Latin threshold + ASCII-letter dominance keeps this safe.
    const r = tryFastPath('café', USER);
    if (r) expect(r.category).not.toBe('non_english');
  });

  it('Longer Hebrew text (>40 chars) bypasses non_english (caller falls through)', () => {
    // Conservative length cap keeps the heuristic narrow.
    const r = tryFastPath('שלום אני רוצה לדעת מה הזמן ואיפה אני נמצאת היום', USER);
    expect(r).toBeNull();
  });

  it('non_english reply varies by user (hash rotation)', () => {
    const a = tryFastPath('hola', '+15550000001');
    const b = tryFastPath('hola', '+15550000002');
    expect(a?.text).not.toBe(undefined);
    expect(b?.text).not.toBe(undefined);
    // Both are valid non_english replies but possibly different.
    expect(a?.category).toBe('non_english');
    expect(b?.category).toBe('non_english');
  });
});

describe('every fast-path reply survives the webhook empty-response gate (2026-06-11 fix)', () => {
  // webhook.ts drops any response without a 3+ char alphanumeric run
  // (hasUsefulContent). A pool entry like '😄' or 'Hi 🤍' therefore means the
  // user gets NO reply at all. Brute-force every category × many seeds and
  // assert every reachable reply passes the gate.
  const WEBHOOK_USEFUL_CONTENT_RE = /[A-Za-z0-9]{3,}/;
  const INPUTS = [
    'Hi', 'hello', 'thanks', 'thank you', 'ok', 'got it', 'goodnight', 'good night',
    "I'm feeling great", "I'm exhausted", 'haha', 'lol', "you're the best",
    'love it', 'wow', 'sorry', 'bye', 'see you later', 'yes', 'no', "I'm good", 'hola',
  ];

  it('no reachable fast-path reply is droppable', () => {
    const dropped: Array<{ input: string; category: string; reply: string }> = [];
    const seen = new Set<string>();
    for (const input of INPUTS) {
      for (let i = 0; i < 300; i++) {
        const r = tryFastPath(input, `+1555${String(i).padStart(7, '0')}`);
        if (!r) break;
        const key = `${r.category}|${r.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!WEBHOOK_USEFUL_CONTENT_RE.test(r.text.trim())) {
          dropped.push({ input, category: r.category, reply: r.text });
        }
      }
    }
    expect(dropped).toEqual([]);
    expect(seen.size).toBeGreaterThan(40); // sanity: we actually sampled the pools
  });
});
