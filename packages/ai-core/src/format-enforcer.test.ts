import { describe, it, expect } from 'vitest';
import { enforceFormat } from './format-enforcer.js';

describe('enforceFormat', () => {
  describe('em / en / double dashes', () => {
    it('replaces em dash with comma', () => {
      const { text, fixes } = enforceFormat('Greek yogurt — easy 17g hit on a GLP-1 stomach.');
      expect(text).toBe('Greek yogurt, easy 17g hit on a GLP-1 stomach.');
      expect(fixes).toContain('em_dash_replaced');
    });

    it('replaces en dash with comma', () => {
      const { text } = enforceFormat('Range is 1.2–1.6g/kg.');
      expect(text).toBe('Range is 1.2, 1.6g/kg.');
    });

    it('replaces double dash with comma', () => {
      const { text, fixes } = enforceFormat('Solid choice -- you are doing great.');
      expect(text).toBe('Solid choice, you are doing great.');
      expect(fixes).toContain('double_dash_replaced');
    });

    it('replaces " - " hyphen-dash with comma', () => {
      const { text } = enforceFormat('Logged - you are at 30g today.');
      expect(text).toBe('Logged, you are at 30g today.');
    });

    it('preserves compound words like easy-to-digest', () => {
      const { text } = enforceFormat('Look for easy-to-digest foods.');
      expect(text).toBe('Look for easy-to-digest foods.');
    });
  });

  describe('markdown stripping', () => {
    it('strips **bold** markdown', () => {
      const { text, fixes } = enforceFormat('Try **Greek yogurt** for protein.');
      expect(text).toBe('Try Greek yogurt for protein.');
      expect(fixes).toContain('markdown_bold_stripped');
    });

    it('strips *italic* markdown', () => {
      const { text } = enforceFormat('That is *really* important.');
      expect(text).toBe('That is really important.');
    });

    it('strips _underscore_ italic', () => {
      const { text } = enforceFormat('That is _really_ important.');
      expect(text).toBe('That is really important.');
    });

    it('does not strip apostrophes or contractions', () => {
      const { text } = enforceFormat("Don't worry, it's fine.");
      expect(text).toBe("Don't worry, it's fine.");
    });

    it('strips markdown headers', () => {
      const { text, fixes } = enforceFormat('## Protein options\nGreek yogurt is great.');
      expect(text).toBe('Protein options\nGreek yogurt is great.');
      expect(fixes).toContain('markdown_header_stripped');
    });
  });

  describe('list flattening', () => {
    it('flattens numbered lists into prose', () => {
      const input = 'Good options:\n1. Greek yogurt\n2. Cottage cheese\n3. Eggs';
      const { text, fixes } = enforceFormat(input);
      expect(text).toBe('Good options:\nGreek yogurt, Cottage cheese, and Eggs');
      expect(fixes).toContain('numbered_list_flattened');
    });

    it('flattens bulleted lists into prose', () => {
      const input = '- Greek yogurt\n- Cottage cheese\n- Eggs';
      const { text, fixes } = enforceFormat(input);
      expect(text).toBe('Greek yogurt, Cottage cheese, and Eggs');
      expect(fixes).toContain('bullet_list_flattened');
    });

    it('does not flatten a lone numbered item (could be an ordinal)', () => {
      const { text, fixes } = enforceFormat('1. is the priority.');
      expect(text).toBe('1. is the priority.');
      expect(fixes).not.toContain('numbered_list_flattened');
    });
  });

  describe('greeting exclamation strip', () => {
    it('replaces "Good morning!" with "Good morning."', () => {
      const { text, fixes } = enforceFormat('Good morning! Hope you slept well.');
      expect(text).toBe('Good morning. Hope you slept well.');
      expect(fixes).toContain('greeting_exclamation_stripped');
    });

    it('replaces "Hi Sarah!" with "Hi Sarah."', () => {
      const { text } = enforceFormat('Hi Sarah! How are you feeling today.');
      expect(text).toBe('Hi Sarah. How are you feeling today.');
    });

    it('strips mid-sentence exclamations too (2026-05-30 clinical report H5)', () => {
      // Updated from the original "preserves thanks!" behavior — the report
      // requires "!" to be banned ANYWHERE in the response, not just on
      // greetings. Auto-rewrite to "." regardless of position.
      const { text, fixes } = enforceFormat('Sounds great, thanks!');
      expect(text).toBe('Sounds great, thanks.');
      expect(fixes).toContain('exclamation_marks_stripped');
    });
  });

  describe('[link] placeholder', () => {
    it('replaces "[link]" with the real settings URL', () => {
      const { text, fixes } = enforceFormat('Update it here: [link]');
      expect(text).toBe('Update it here: https://graceglp.com/settings');
      expect(fixes).toContain('link_placeholder_replaced');
    });

    it('replaces "[settings link]" with the URL', () => {
      const { text } = enforceFormat('Use [settings link] to change it.');
      expect(text).toBe('Use https://graceglp.com/settings to change it.');
    });
  });

  describe('first name stripping', () => {
    it('strips name with trailing comma: "Got it, Yuval."', () => {
      const { text, fixes } = enforceFormat('Got it, Yuval. I will keep that in mind.', { stripFirstName: 'Yuval' });
      expect(text).toBe('Got it. I will keep that in mind.');
      expect(fixes).toContain('user_name_stripped');
    });

    it('strips name with leading comma: "Sarah, that is great."', () => {
      const { text } = enforceFormat('Sarah, that is great.', { stripFirstName: 'Sarah' });
      expect(text).toBe('That is great.');
    });

    it('strips standalone name occurrence', () => {
      const { text } = enforceFormat('You are doing great Sarah today.', { stripFirstName: 'Sarah' });
      expect(text).toBe('You are doing great today.');
    });

    it('does not strip when stripFirstName is not provided', () => {
      const { text } = enforceFormat('Got it, Yuval. I will keep that in mind.');
      expect(text).toBe('Got it, Yuval. I will keep that in mind.');
    });

    it('case-insensitive name matching', () => {
      const { text } = enforceFormat('Got it, YUVAL. Cool.', { stripFirstName: 'Yuval' });
      expect(text).toBe('Got it. Cool.');
    });
  });

  describe('combined real-world response', () => {
    it('cleans the production screenshot bug: "Got it, Yuval. ..."', () => {
      const input = 'Got it, Yuval — I\'ll **definitely** keep that in mind for any food ideas!';
      const { text } = enforceFormat(input, { stripFirstName: 'Yuval' });
      expect(text).not.toContain('Yuval');
      expect(text).not.toContain('—');
      expect(text).not.toContain('**');
    });
  });

  describe('duplicate previous-message prefix strip', () => {
    const prevMsg =
      'Ugh, nausea is really rough. For common GLP-1 nausea, small bland meals, ginger tea or chews, and sipping water between meals often help.';

    it('strips the repeated prefix when Gemini copy-pastes the last response before new content', () => {
      // Production bug: the new reply begins with the entire previous message,
      // then appends the real answer at the end.
      const newContent = "I don't have a log of where you injected yesterday, no.";
      const input = prevMsg + ' ' + newContent;
      const { text, fixes } = enforceFormat(input, { lastAssistantMessage: prevMsg });
      expect(fixes).toContain('duplicate_prev_message_stripped');
      // The result should only contain the genuinely new content.
      expect(text).toContain('I don\'t have a log');
      // The repeated prefix must be gone.
      expect(text).not.toMatch(/^Ugh, nausea/);
    });

    it('does not strip when there is no overlap with the previous message', () => {
      const freshReply = 'No, I don\'t have that logged — was there something with the injection site?';
      const { fixes } = enforceFormat(freshReply, { lastAssistantMessage: prevMsg });
      expect(fixes).not.toContain('duplicate_prev_message_stripped');
    });

    it('does not strip when the overlap is too short (< 40 chars)', () => {
      // Previous message starts with "Ugh" — a new message that also starts
      // with "Ugh" (10 chars overlap) should NOT be stripped.
      const prev = 'Ugh, hang in there — that sounds tough.';
      const newReply = 'Ugh, that\'s a rough one. Try some ginger tea.';
      const { fixes } = enforceFormat(newReply, { lastAssistantMessage: prev });
      expect(fixes).not.toContain('duplicate_prev_message_stripped');
    });

    it('does not strip when the previous message is under 40 chars', () => {
      const shortPrev = 'Got it.';
      const newReply = 'Got it. How are you feeling today?';
      const { fixes } = enforceFormat(newReply, { lastAssistantMessage: shortPrev });
      expect(fixes).not.toContain('duplicate_prev_message_stripped');
    });
  });

  describe('hard length cap (WhatsApp readability)', () => {
    it('does not touch responses under the context cap', () => {
      const input = 'Short reply that ends cleanly.';
      const { text, fixes } = enforceFormat(input, { messageContext: 'general' });
      expect(text).toBe(input);
      expect(fixes).not.toContain('length_capped');
    });

    it('truncates at the last sentence ending within the context cap (general=400)', () => {
      // s1 ends at ~117, s2 ends at ~334 (both within the 400-char window).
      // Tail starts at 334 and pushes total > 400, so it gets dropped.
      const s1 = 'A'.repeat(100) + ' first sentence. ';   // 118 chars, period at 116
      const s2 = 'B'.repeat(200) + ' second sentence. ';  // starts at 118, period at ~334
      const tail = 'C'.repeat(200) + ' tail should be dropped.'; // starts at ~336
      const input = s1 + s2 + tail;
      const { text, fixes } = enforceFormat(input, { messageContext: 'general' });
      expect(fixes).toContain('length_capped');
      expect(text.length).toBeLessThanOrEqual(400);
      // Must end with a period — never mid-word or mid-sentence.
      expect(text.endsWith('.')).toBe(true);
      expect(text).toContain('second sentence.');
      expect(text).not.toContain('tail should');
    });

    it('does NOT cut at "e.g." or other abbreviations even when they sit past position 300', () => {
      // 350 X's, then an "e.g." abbreviation, then a real sentence ending at ~450,
      // then 250 Y's so total > 600 and the cap fires.
      const input =
        'X'.repeat(350) +
        'e.g. Greek yogurt helps a lot with your protein goal. ' +
        'Y'.repeat(250);
      const { text, fixes } = enforceFormat(input);
      expect(fixes).toContain('length_capped');
      // Should cut at "protein goal." (the real sentence end), not at "e.g."
      expect(text.endsWith('protein goal.')).toBe(true);
      // And not at "e.g." (false-positive abbreviation cut).
      expect(text).not.toMatch(/e\.g\.$/);
    });

    it('does not truncate when no valid sentence boundary exists past position 300 (avoids mid-sentence cut)', () => {
      // 700 chars with no period, !, or ? anywhere — should NOT cut at all.
      const input = 'A'.repeat(700);
      const { text, fixes } = enforceFormat(input);
      expect(fixes).not.toContain('length_capped');
      // Original text returned (no cut), but our trailing whitespace cleanup
      // may shave the string. Length should be at least within 5 chars of original.
      expect(text.length).toBeGreaterThanOrEqual(input.length - 5);
    });

    it('handles "!" and "?" as sentence terminators', () => {
      const input =
        'A'.repeat(400) + ' That sounds great! ' +
        'B'.repeat(100) + ' Could you tell me more? ' +
        'C'.repeat(300);
      const { text, fixes } = enforceFormat(input);
      expect(fixes).toContain('length_capped');
      expect(text.length).toBeLessThanOrEqual(600);
      // Must end with one of the terminal chars.
      expect(/[.!?]$/.test(text)).toBe(true);
    });

    it('matches a sentence ending at the very last position of the window (no trailing space)', () => {
      // 588 chars of 'A' + 'great choice.' (13 chars) = 601 chars total.
      // The period sits at index 600 — exactly at window boundary.
      const input = 'A'.repeat(588) + 'great choice.';
      const { text } = enforceFormat(input);
      // Either capped (returns full text since len ≤ 600 isn't true) or untouched.
      // Either way, must not be cut mid-word.
      expect(text.endsWith('.')).toBe(true);
      expect(text.endsWith('great choice.')).toBe(true);
    });
  });

  // ── 2026-05-30 clinical report additions ───────────────────────────────
  describe('clinical report H5 — exclamation marks stripped anywhere', () => {
    it('strips multiple "!" anywhere in the response', () => {
      const { text, fixes } = enforceFormat('That makes sense! Try cold foods first! It really helps!');
      expect(text).not.toContain('!');
      expect(text).toBe('That makes sense. Try cold foods first. It really helps.');
      expect(fixes).toContain('exclamation_marks_stripped');
    });

    it('does not add the fix when there were no exclamations', () => {
      const { fixes } = enforceFormat('Greek yogurt, cottage cheese, eggs.');
      expect(fixes).not.toContain('exclamation_marks_stripped');
    });
  });

  describe('clinical report H3 — label:description list disguised as prose', () => {
    it('flattens 2+ "Label: description" lines into prose with em-dash connector', () => {
      const input = 'Try these. Greek yogurt: 15g protein in a cup. Cottage cheese: 25g protein.';
      const { text, fixes } = enforceFormat(input);
      expect(fixes).toContain('label_colon_flattened');
      expect(text).not.toMatch(/Greek yogurt:/);
      expect(text).not.toMatch(/Cottage cheese:/);
    });

    it('leaves a single Label: description alone (could be a definition)', () => {
      const { fixes } = enforceFormat('Telogen effluvium: temporary hair shedding from rapid weight loss.');
      expect(fixes).not.toContain('label_colon_flattened');
    });
  });

  describe('truncation + orphaned enumeration markers (session 3 feedback)', () => {
    it('strips dangling "1." at end of response (production failure: Ozempic breakdown)', () => {
      // After listIntroRe strips "Here's a breakdown of how Ozempic actually works in the body: ",
      // the remaining text was "Ozempic ... weight management. 1."
      // Orphaned "1." at the end has to go.
      const input = 'Ozempic is used for weight management. Here\'s a breakdown of how Ozempic actually works in the body: 1.';
      const { text, fixes } = enforceFormat(input);
      expect(fixes).toContain('list_intro_stripped');
      expect(text).not.toMatch(/\b1\.\s*$/);
    });

    it('flags truncation_suspected when response ends without terminal punctuation', () => {
      const input = 'Ozempic mimics a hormone called GLP-1, which slows digestion and reduces appetite, and it also helps with weight management because';
      const { fixes } = enforceFormat(input);
      expect(fixes).toContain('truncation_suspected');
    });

    it('does NOT flag truncation_suspected when response ends with a period', () => {
      const input = 'Ozempic mimics a hormone called GLP-1, which slows digestion and reduces appetite. It also helps with weight management.';
      const { fixes } = enforceFormat(input);
      expect(fixes).not.toContain('truncation_suspected');
    });

    it('does NOT flag truncation_suspected when response ends with an emoji', () => {
      const input = 'Two eggs and a salad — about 15g protein. You\'re at 40g today 👍';
      const { fixes } = enforceFormat(input);
      expect(fixes).not.toContain('truncation_suspected');
    });

    it('strips orphan numbered marker only when list-intro was also stripped', () => {
      // "1." in regular prose stays put (ordinal usage)
      const { fixes: lonelyFixes } = enforceFormat('Step 1. is the priority for muscle preservation.');
      expect(lonelyFixes).not.toContain('orphaned_enumeration_stripped');
    });
  });
});
