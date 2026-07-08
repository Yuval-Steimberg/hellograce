import { describe, it, expect } from 'vitest';
import { enforceFormat } from './format-enforcer.js';

describe('enforceFormat', () => {
  describe('em / en / double dashes', () => {
    it('replaces em dash with comma', () => {
      const { text, fixes } = enforceFormat('Greek yogurt — easy 17g hit on a GLP-1 stomach.');
      expect(text).toBe('Greek yogurt, easy 17g hit on a GLP-1 stomach.');
      expect(fixes).toContain('em_dash_replaced');
    });

    it('replaces non-numeric en dash with comma', () => {
      const { text } = enforceFormat('chicken – protein-dense option');
      expect(text).toBe('chicken, protein-dense option');
    });

    it('preserves NUMERIC en-dash range as hyphen (2026-06-05 fix)', () => {
      // Production failure: "64–80 ounces" got converted to "64, 80
      // ounces" — incomprehensible. Ranges must stay readable.
      const { text } = enforceFormat('Range is 1.2–1.6g/kg.');
      expect(text).toBe('Range is 1.2-1.6g/kg.');
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

  describe('residual markdown sweep — zero artifacts reach the user (2026-06-14)', () => {
    it('strips a stray bullet that follows a comma (the exact production failure)', () => {
      const input =
        "Since you're vegetarian and looking for something gentle on a GLP-1 stomach, * Greek yogurt power bowl: Mix nonfat Greek yogurt with blueberries.";
      const { text } = enforceFormat(input, { messageContext: 'food_question' });
      expect(text).not.toContain('*');
      // The bullet + its leading comma-space collapse cleanly into prose.
      expect(text).toContain('GLP-1 stomach, Greek yogurt power bowl');
    });

    it('removes an unpaired (unclosed) asterisk anywhere', () => {
      const { text, fixes } = enforceFormat('Try *Greek yogurt for protein.');
      expect(text).not.toContain('*');
      expect(fixes).toContain('residual_asterisk_stripped');
    });

    it('removes a trailing stray asterisk', () => {
      const { text } = enforceFormat('Greek yogurt is great *');
      expect(text).not.toContain('*');
    });

    it('strips horizontal-rule separator lines (---, ___)', () => {
      const { text } = enforceFormat('Here is the plan.\n---\nEat more protein.');
      expect(text).not.toMatch(/---/);
      expect(text).toContain('Eat more protein.');
    });

    it('strips an inline header marker mid-text but keeps "#1" / "#5"', () => {
      const { text } = enforceFormat('Protein matters. # Summary stuff here.');
      expect(text).not.toMatch(/#\s/);
      const keep = enforceFormat('You are my #1 priority.');
      expect(keep.text).toContain('#1');
    });

    it('does not touch clean prose with no markdown', () => {
      const clean = 'A Greek yogurt bowl is a great option. Mix it with berries and chia seeds.';
      expect(enforceFormat(clean).text).toBe(clean);
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

  describe('meta-analysis opener strip (2026-07-02 production)', () => {
    it('strips "It looks like you\'re asking… Let\'s break it down."', () => {
      const { text, fixes } = enforceFormat(
        "It looks like you're asking for a mix of food-related advice and calculations. Let's break it down. Salmon with potatoes and salad runs about 30-35g of protein, a really solid meal.",
      );
      expect(fixes).toContain('filler_opener_stripped');
      expect(text.startsWith('Salmon with potatoes')).toBe(true);
      expect(text).not.toMatch(/looks like you'?re asking|break it down/i);
    });
    it('strips "Let\'s break down your questions about protein and meals."', () => {
      const { text } = enforceFormat(
        "Let's break down your questions about protein and meals. Your salmon dinner was roughly 30g of protein, and a Greek yogurt later would round out the day nicely.",
      );
      expect(text.startsWith('Your salmon dinner')).toBe(true);
    });
    it('strips "Here\'s an analysis of your entries, categorizing them…"', () => {
      const { text } = enforceFormat(
        "Here's an analysis of your entries, categorizing them and providing responses where appropriate: That's great to hear. Since you're feeling good, let's make Friday night special with a simple sheet-pan chicken dinner.",
      );
      expect(text).not.toMatch(/analysis of your entries|categorizing/i);
      expect(text).toMatch(/Friday night/);
    });
    it('strips CHAINED preambles + hedge (the exact salmon production reply)', () => {
      const { text } = enforceFormat(
        "That sounds like a delicious and nutritious meal. Let's break down the protein and then discuss your next steps. It's tough to give an exact number without knowing the precise quantities, but salmon with potatoes and salad is roughly 30-35g of protein, and a Greek yogurt later would round out your day.",
      );
      expect(text).not.toMatch(/sounds like a delicious|let'?s break|tough to give/i);
      expect(text).toMatch(/salmon with potatoes/i);
      expect(text.startsWith('Salmon')).toBe(true);
    });
    it('strips a leading gerund HEADING + disclaimer (the salmon breakdown reply)', () => {
      const { text } = enforceFormat(
        "Estimating Protein in Your Salmon Meal: This is a rough estimate as portion sizes vary, but a 4 oz salmon fillet has about 22-26g of protein, and a Greek yogurt later would round out your day.",
      );
      expect(text).not.toMatch(/estimating protein in your|this is a rough estimate/i);
      expect(text.startsWith('A 4 oz salmon') || text.startsWith('A 4Oz salmon')).toBe(true);
      expect(text).toMatch(/22-26g/);
    });
    it('leaves a normal answer untouched', () => {
      const input = 'So glad that meal sat well. For Friday night, a sheet-pan lemon chicken with veggies is easy and satisfying.';
      const { text } = enforceFormat(input);
      expect(text).toBe(input);
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

    it('hard-caps a long run-on with no late sentence boundary (essay guard, 2026-07-02)', () => {
      // A rambling reply whose only period is an early opener, then a colon/comma
      // "Option 1 / Option 2" list — the exact production failure. It MUST be
      // capped now (previously the whole essay shipped).
      const input =
        'A protein shake is a good way to stay full. ' + // the only early period
        'For Friday night you might consider a few simple options here, ' +
        'a sheet pan dinner with chicken sausage and veggies like broccoli bell peppers and sweet potatoes roasted together, ' +
        'or a big salad with grilled chicken salmon or chickpeas plus some quinoa, ' +
        'homemade pizza on a flatbread with your favorite toppings, ' +
        'pasta with a quick tomato or pesto sauce and shrimp, ' +
        'or build your own tacos with beans and lots of toppings to keep it satisfying on a busy night';
      const { text, fixes } = enforceFormat(input, { messageContext: 'general' });
      expect(fixes).toContain('length_capped');
      expect(text.length).toBeLessThanOrEqual(501); // general cap (500) + terminal char
      expect(text).not.toContain('busy night'); // the rambling tail is gone
      expect(/[.!?…]$/.test(text)).toBe(true);   // ends cleanly
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

    it('captures a sentence ending exactly at the window boundary (knowledge cap 600)', () => {
      // With the knowledge cap (600), a period sitting right at the boundary is
      // captured by the primary path — nothing is lost.
      const input = 'A'.repeat(587) + ' great choice.'; // period at index 600
      const { text } = enforceFormat(input, { messageContext: 'knowledge' });
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

  describe('multi-question collapse must not mangle a URL query string (2026-07-02 production fix)', () => {
    it('preserves ?phone= in a link even when the message also ends with a question', () => {
      const { text } = enforceFormat(
        'head to https://grace-admin-silk.vercel.app/upgrade?phone=%2B972547722420 to subscribe. Questions? Reply HELP.',
      );
      expect(text).toContain('/upgrade?phone=%2B972547722420');
      expect(text).not.toContain('/upgrade.phone=');
    });

    it('still collapses genuine multiple questions in prose', () => {
      const { text, fixes } = enforceFormat('How are you? Feeling ok? Anything else?');
      expect(fixes).toContain('multi_question_collapsed');
      expect(text).toBe('How are you. Feeling ok. Anything else?');
    });

    it('does not touch digits outside URLs when restoring (no "3-day" corruption)', () => {
      const { text } = enforceFormat(
        'Your 3-day trial ended. Visit https://x.com/upgrade?phone=1 now? Reply HELP.',
      );
      expect(text).toContain('3-day');
      expect(text).toContain('https://x.com/upgrade?phone=1');
    });
  });

  describe('missing space after period + duplicate sentence (2026-06-01 production fix)', () => {
    it('inserts the missing space after a period before a capital letter', () => {
      const { text, fixes } = enforceFormat(
        "I don't have any food logged for you today.You're at 0g protein so far.",
      );
      expect(fixes).toContain('missing_space_after_period');
      expect(text).toContain('today. You');
      expect(text).not.toContain('today.You');
    });

    it('collapses two near-identical sentences to the first one only', () => {
      const input =
        "I don't have any food logged for you today, so you're at 0g protein so far. You're at 0g protein for the day so far.";
      const { text, fixes } = enforceFormat(input);
      expect(fixes).toContain('duplicate_sentence_stripped');
      // The second "You're at 0g protein..." sentence should be gone.
      const occurrences = (text.match(/you'?re at 0g/gi) ?? []).length;
      expect(occurrences).toBeLessThanOrEqual(1);
    });

    it('also handles the combined production failure (no space + duplicate)', () => {
      const input =
        "I don't have any food logged for you today, so you're at 0g protein so far.You're at 0g protein for the day so far.";
      const { text } = enforceFormat(input);
      // After both fixes, the response should read as one cohesive sentence.
      expect(text).toContain("today, so you're at 0g protein so far.");
      const occurrences = (text.match(/you'?re at 0g/gi) ?? []).length;
      expect(occurrences).toBeLessThanOrEqual(1);
    });

    it('does NOT collapse two distinct sentences that just happen to start with the same word', () => {
      const input = "You're feeling rough — that's normal early on. You'll see it ease by week 4.";
      const { text, fixes } = enforceFormat(input);
      // Different content past the first 30 chars → both kept
      expect(fixes).not.toContain('duplicate_sentence_stripped');
      expect(text).toContain("week 4");
    });
  });

  describe('user message echo strip', () => {
    it('strips verbatim parroting of the user message at the start of food-log response', () => {
      // Exact production failure from screenshot 2026-06-02
      const input = "I ate two eggs is about 12g protein. You're at 35g of your 60g target today.";
      const { text, fixes } = enforceFormat(input, { userMessage: 'I ate two eggs' });
      expect(fixes).toContain('user_message_echo_stripped');
      expect(text).not.toMatch(/^I ate two eggs/i);
      // Remaining content should still be meaningful
      expect(text).toMatch(/12g protein/);
      expect(text).toMatch(/35g/);
    });

    it('strips echoed prefix and the linking verb "is"', () => {
      const input = "Big Mac and fries is about 30g protein. You're at 30/60g today.";
      const { text } = enforceFormat(input, { userMessage: 'Big Mac and fries' });
      expect(text).not.toMatch(/^Big Mac and fries is/i);
      expect(text).toMatch(/30g protein/);
    });

    it('handles "Just had X" echo patterns', () => {
      const input = "Just had a protein shake — that's about 25g protein. You're at 25g today.";
      const { text } = enforceFormat(input, { userMessage: 'Just had a protein shake' });
      expect(text).not.toMatch(/^Just had/i);
      expect(text).toMatch(/25g protein/);
    });

    it('does NOT strip when response does not echo the user', () => {
      // Note: em-dash gets converted to "," by a separate pass; we only check
      // the echo-strip didn't fire.
      const input = "Two eggs, about 12g protein. You are at 35g today.";
      const { text, fixes } = enforceFormat(input, { userMessage: 'I ate two eggs' });
      expect(fixes).not.toContain('user_message_echo_stripped');
      expect(text).toMatch(/^Two eggs/);
    });

    it('skips short user messages to avoid false positives', () => {
      const input = "Eggs are great. You should keep going.";
      const { text, fixes } = enforceFormat(input, { userMessage: 'hi' });
      expect(fixes).not.toContain('user_message_echo_stripped');
      expect(text).toBe(input);
    });

    it('only strips when remainder is substantial (>=10 chars)', () => {
      // If stripping leaves almost nothing, the strip is rejected
      const input = "Two eggs ok.";
      const { text } = enforceFormat(input, { userMessage: 'Two eggs' });
      // Remainder "ok." is too short → no strip
      expect(text).toBe(input);
    });

    it('strips with trailing punctuation between echo and content', () => {
      const input = "Chicken and rice: roughly 34g protein. You're at 40g today.";
      const { text } = enforceFormat(input, { userMessage: 'chicken and rice' });
      expect(text).not.toMatch(/^Chicken and rice:/i);
      expect(text).toMatch(/34g protein/);
    });

    it('capitalizes the new first letter after stripping a word-leading remainder', () => {
      const input = "I had eggs that gives you about 12g protein. You're at 12g today.";
      const { text } = enforceFormat(input, { userMessage: 'I had eggs' });
      // After stripping "I had eggs " → "that gives you..." → "That gives..."
      expect(text.charAt(0)).toMatch(/[A-Z]/);
    });
  });

  // A multi-part answer reads clearest as one short section per part. By default
  // paragraph breaks are collapsed (WhatsApp reads a blank line as a new
  // message); the opt-in preserveParagraphs keeps them for multi-part replies.
  describe('preserveParagraphs — multi-part sectioning (opt-in)', () => {
    const multi = 'You are on track today.\n\nFor tonight, try Greek yogurt.\n\nFor Friday, protein first, then dessert.';

    it('DEFAULT collapses paragraphs to one (unchanged behavior)', () => {
      const { text, fixes } = enforceFormat(multi, {});
      expect(text).not.toContain('\n');
      expect(fixes).toContain('paragraphs_collapsed');
      expect(text).toContain('You are on track today. For tonight');
    });

    it('preserveParagraphs KEEPS one blank line between each part', () => {
      const { text, fixes } = enforceFormat(multi, { preserveParagraphs: true });
      expect(fixes).toContain('paragraphs_preserved');
      expect(text.split('\n\n')).toHaveLength(3);
      expect(fixes).not.toContain('paragraphs_collapsed');
    });

    it('a SINGLE mid-paragraph newline becomes a SPACE, never deletes (no word-merge)', () => {
      // Prod: "cheese stick\ncan" collapsed to "stickcan". Must be "stick can".
      const input = 'A tiny snack now\nlike a few bites of a cheese stick\ncan help.\n\nFor your order, grilled chicken.';
      const { text } = enforceFormat(input, { preserveParagraphs: true });
      expect(text).toContain('snack now like');
      expect(text).toContain('cheese stick can help');
      expect(text).not.toContain('stickcan');
      expect(text.split('\n\n')).toHaveLength(2);
    });

    it('normalizes 3+ blank lines down to a single gap', () => {
      const { text } = enforceFormat('Part one.\n\n\n\nPart two.', { preserveParagraphs: true });
      expect(text).toBe('Part one.\n\nPart two.');
    });

    it('a single-paragraph reply is unchanged either way', () => {
      const single = 'Logged 2 eggs. You are at 12g protein today.';
      expect(enforceFormat(single, {}).text).toBe(single);
      expect(enforceFormat(single, { preserveParagraphs: true }).text).toBe(single);
    });
  });
});
