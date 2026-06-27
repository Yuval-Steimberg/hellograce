import { describe, it, expect } from 'vitest';
import { GRACE_VOICE, GRACE_VOICE_BRIEF, buildAntiRepetitionHint, voiceSuffix } from './voice.js';

describe('GRACE_VOICE content', () => {
  it('encodes the friend-not-bot, vary, no-cliché, no-reflex-question rules', () => {
    expect(GRACE_VOICE).toMatch(/not a clinician|corporate health bot/i);
    expect(GRACE_VOICE).toMatch(/VARY/);
    expect(GRACE_VOICE).toMatch(/great job|you've got this/i); // listed as phrases to avoid
    expect(GRACE_VOICE).toMatch(/Don't reflexively end with a question/i);
    expect(GRACE_VOICE_BRIEF).toMatch(/clich/i);
  });
});

describe('buildAntiRepetitionHint', () => {
  it('returns empty when there is no assistant history', () => {
    expect(buildAntiRepetitionHint([])).toBe('');
    expect(buildAntiRepetitionHint([{ role: 'user', content: 'hi' }])).toBe('');
  });

  it('lists the openers of the recent assistant replies', () => {
    const hint = buildAntiRepetitionHint([
      { role: 'user', content: 'how do I get more protein' },
      { role: 'assistant', content: 'Great question — adding eggs in the morning is an easy win for you.' },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'Anytime. Want me to track that tomorrow?' },
    ]);
    expect(hint).toMatch(/DON'T REPEAT YOURSELF/);
    expect(hint).toContain('Great question — adding eggs in');
    expect(hint).toContain('Anytime. Want me to track');
  });

  it('only considers the last 4 assistant turns', () => {
    const turns = Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', content: `Reply number ${i} here now ok` }));
    const hint = buildAntiRepetitionHint(turns);
    expect(hint).toContain('Reply number 7 here now ok');
    expect(hint).not.toContain('Reply number 3 here');
  });
});

describe('voiceSuffix', () => {
  it('includes the full voice block plus the anti-repetition hint', () => {
    const s = voiceSuffix([{ role: 'assistant', content: 'Hey there, glad you checked in today friend' }]);
    expect(s).toContain("HOW YOU TALK");
    expect(s).toContain('Hey there, glad you checked');
  });
});
