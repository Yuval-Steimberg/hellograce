import { describe, it, expect } from 'vitest';
import { sanitizeOutbound } from './sender.js';

describe('sanitizeOutbound — em-dash replacement', () => {
  it('replaces em-dashes with commas', () => {
    const out = sanitizeOutbound('Got it — moved your injection day.');
    expect(out).toBe('Got it, moved your injection day.');
    expect(out).not.toContain('—');
  });

  it('replaces en-dashes with commas', () => {
    const out = sanitizeOutbound('Sucks to hear that – rough night?');
    expect(out).not.toContain('–');
  });

  it('replaces double-dashes with commas', () => {
    const out = sanitizeOutbound('Got it -- handling it now.');
    expect(out).toBe('Got it, handling it now.');
  });

  it('replaces " - " single-hyphen-as-dash with comma', () => {
    const out = sanitizeOutbound('Got it - moved your injection day.');
    expect(out).toBe('Got it, moved your injection day.');
  });

  it('does NOT mangle compound words like easy-to-digest', () => {
    const out = sanitizeOutbound('Try easy-to-digest options.');
    expect(out).toBe('Try easy-to-digest options.');
  });

  it('handles multiple em-dashes in one message', () => {
    const out = sanitizeOutbound('Hey — quick note — your protein is solid today.');
    expect(out).not.toContain('—');
    expect(out).toMatch(/^Hey, quick note, your protein is solid today\.$/);
  });
});

describe('sanitizeOutbound — mid-sentence truncation', () => {
  it('trims trailing hyphen + partial word to last complete sentence', () => {
    const out = sanitizeOutbound('You got this. Try easy-to-');
    expect(out).toBe('You got this.');
  });

  it('drops stranded prepositions when no terminator present', () => {
    const out = sanitizeOutbound('Greek yogurt is a solid pick of');
    expect(out.endsWith('.')).toBe(true);
    expect(out).not.toMatch(/\s+of$/i);
  });

  it('adds a period when no terminator and no recoverable sentence', () => {
    const out = sanitizeOutbound('Greek yogurt works');
    expect(out).toBe('Greek yogurt works.');
  });

  it('preserves complete sentences ending with period', () => {
    const out = sanitizeOutbound('Got it, your injection day is now Sunday.');
    expect(out).toBe('Got it, your injection day is now Sunday.');
  });

  it('preserves complete sentences ending with question mark', () => {
    const out = sanitizeOutbound('Rough night of sleep?');
    expect(out).toBe('Rough night of sleep?');
  });

  it('preserves complete sentences ending with emoji', () => {
    const out = sanitizeOutbound('Love hearing that 🧡');
    expect(out).toBe('Love hearing that 🧡');
  });

  it('preserves complete sentences ending with exclamation', () => {
    const out = sanitizeOutbound('Glad to hear that!');
    expect(out).toBe('Glad to hear that!');
  });

  it('keeps last complete thought when LLM truncates mid-word at the end', () => {
    const out = sanitizeOutbound(
      "You're crushing it this week. For protein, focus on dense, easy-to-",
    );
    expect(out).toBe("You're crushing it this week.");
  });

  it('handles empty / whitespace-only input gracefully', () => {
    expect(sanitizeOutbound('')).toBe('');
    expect(sanitizeOutbound('   ')).toBe('   ');
  });
});

describe('sanitizeOutbound — real production failure modes', () => {
  it('cleans the safety-guard message that has an em-dash', () => {
    const input =
      "That's really one for your prescribing clinician — they can give you the right answer.";
    const out = sanitizeOutbound(input);
    expect(out).not.toContain('—');
    expect(out.endsWith('.')).toBe(true);
  });

  it('cleans the webhook fallback that has an em-dash', () => {
    const out = sanitizeOutbound('My connection blipped — what were you saying?');
    expect(out).not.toContain('—');
    expect(out.endsWith('?')).toBe(true);
  });

  it('cleans a scheduler proactive message that has an em-dash', () => {
    const out = sanitizeOutbound('Morning 🌿 Mid-week check — how are you feeling?');
    expect(out).not.toContain('—');
  });
});
