import { describe, it, expect } from 'vitest';
import { detectVagueFood } from './vague-food.js';

describe('detectVagueFood — flags vague brand/category mentions', () => {
  it('flags the exact production bug case: "I ate kfc this morning it was delicious"', () => {
    const r = detectVagueFood('I ate kfc this morning it was delicious');
    expect(r.vague).toBe(true);
    expect(r.matched).toBe('kfc');
    expect(r.response).toMatch(/what.*order|what.*had|specifics|specific|estimate/i);
    expect(r.response).toMatch(/kfc/i);
  });

  it('flags "I ate veggie KFC this morning" (2026-05-29 screenshot — "veggie" alone is not specific)', () => {
    const r = detectVagueFood('I ate veggie KFC this morning');
    expect(r.vague).toBe(true);
    expect(r.matched).toBe('kfc');
    // Never claims to log or estimate without specifics.
    expect(r.response).not.toMatch(/\d+\s*g\b/i);
    expect(r.response!.toLowerCase()).not.toMatch(/logged that you had|i'?ve logged/);
  });

  it('uses the follow-up template when Grace already asked for clarification', () => {
    const firstAsk = "Sounds like you enjoyed it 😊. What did you have at KFC?";
    const r = detectVagueFood('I ate veggie KFC this morning', firstAsk);
    expect(r.vague).toBe(true);
    // Follow-up templates use softer ack words (got it / noted / thanks) and
    // re-ask for the specific item.
    expect(r.response!.toLowerCase()).toMatch(/got it|noted|thanks/);
    expect(r.response!.toLowerCase()).toMatch(/which.*item|specific/);
  });

  it('flags fast food brands without specifics', () => {
    expect(detectVagueFood('I had subway for lunch').vague).toBe(true);
    expect(detectVagueFood('grabbed chipotle').vague).toBe(true);
    expect(detectVagueFood('ate at mcdonalds').vague).toBe(true);
    expect(detectVagueFood("had taco bell").vague).toBe(true);
    expect(detectVagueFood("went to chick-fil-a").vague).toBe(true);
    expect(detectVagueFood("had popeyes").vague).toBe(true);
  });

  it('flags sit-down chains without specifics', () => {
    expect(detectVagueFood("we went to olive garden").vague).toBe(true);
    expect(detectVagueFood("had cheesecake factory").vague).toBe(true);
    expect(detectVagueFood("ate at ihop").vague).toBe(true);
  });

  it('flags generic food categories without specifics', () => {
    expect(detectVagueFood('I had pizza').vague).toBe(true);
    expect(detectVagueFood('ate sushi today').vague).toBe(true);
    expect(detectVagueFood('had chinese food').vague).toBe(true);
    expect(detectVagueFood('got takeout').vague).toBe(true);
    expect(detectVagueFood('finished my leftovers').vague).toBe(true);
    expect(detectVagueFood('had some pasta').vague).toBe(true);
  });

  it('treats "a/an + food word" as specific (implicit quantity 1)', () => {
    // Once the user names a count even informally, we have enough to estimate
    // a typical serving size — no ask needed.
    expect(detectVagueFood('grabbed a burrito').vague).toBe(false);
    expect(detectVagueFood('had a sandwich').vague).toBe(false);
  });
});

describe('detectVagueFood — does NOT flag when specifics are present', () => {
  it('allows brand + number+unit specifics', () => {
    expect(detectVagueFood('I had 3 KFC tenders').vague).toBe(false);
    expect(detectVagueFood('ate 2 slices of pizza').vague).toBe(false);
    expect(detectVagueFood('had 12 mcnuggets').vague).toBe(false);
    expect(detectVagueFood('grabbed a 6 inch subway sandwich').vague).toBe(false);
  });

  it('allows brand + specific menu item', () => {
    expect(detectVagueFood('I had a big mac').vague).toBe(false);
    expect(detectVagueFood('ate a whopper').vague).toBe(false);
    expect(detectVagueFood('had a footlong meatball sub').vague).toBe(false);
    expect(detectVagueFood('grabbed a KFC chicken sandwich').vague).toBe(false);
  });

  it('allows brand + sized portion descriptor', () => {
    expect(detectVagueFood('large pizza from dominos').vague).toBe(false);
    expect(detectVagueFood('a small Wendy\'s burger').vague).toBe(false);
    expect(detectVagueFood('half a personal pizza').vague).toBe(false);
  });

  it('allows generic category + specific item or quantity', () => {
    expect(detectVagueFood('I had a slice of pizza').vague).toBe(false); // "slice"
    expect(detectVagueFood('ate a chicken burrito').vague).toBe(false); // "chicken burrito"
    expect(detectVagueFood('2 cups of pasta').vague).toBe(false);
    expect(detectVagueFood('a chicken sandwich').vague).toBe(false);
  });

  it('allows weight-based specifics (oz, grams)', () => {
    expect(detectVagueFood('had a 12oz steak').vague).toBe(false);
    expect(detectVagueFood('grabbed 200g of pasta').vague).toBe(false);
  });
});

describe('detectVagueFood — does NOT flag non-food messages', () => {
  it('returns vague=false for greetings and unrelated messages', () => {
    expect(detectVagueFood('hi').vague).toBe(false);
    expect(detectVagueFood('how are you').vague).toBe(false);
    expect(detectVagueFood('feeling tired').vague).toBe(false);
    expect(detectVagueFood('I lost 2 pounds this week').vague).toBe(false);
  });

  it('returns vague=false when a specific food (no brand) is mentioned', () => {
    expect(detectVagueFood('I ate grilled chicken').vague).toBe(false);
    expect(detectVagueFood('had a banana').vague).toBe(false);
    expect(detectVagueFood('eggs and toast for breakfast').vague).toBe(false);
  });
});

describe('detectVagueFood — response style', () => {
  it('returns a short clarification that mentions the matched brand', () => {
    const r = detectVagueFood('I had subway');
    expect(r.response).toBeTruthy();
    expect(r.response!.length).toBeLessThan(250);
    expect(r.response!.toLowerCase()).toContain('subway');
  });

  it('never contains a fabricated protein number', () => {
    const r = detectVagueFood('ate kfc');
    expect(r.response).not.toMatch(/\d+\s*g\b/i);
    // Mentioning the word "protein" in the ASK is fine ("I can estimate the protein"),
    // but it must not present a specific number as fact.
    expect(r.response).not.toMatch(/\b\d+\s*g\s*(of\s+)?protein\b/i);
  });

  it('never claims to have logged something it has not', () => {
    // Per 2026-05-29 feedback: don't say "logged" before we actually know what
    // to log. "Got it — noting that you had X" is fine; "I've logged X" is not.
    const r = detectVagueFood('I ate kfc');
    expect(r.response!.toLowerCase()).not.toMatch(/\bi(?:'ve)?\s+logged\b/);
  });

  it('returns the same response for the same input (stable hash)', () => {
    const r1 = detectVagueFood('I ate kfc');
    const r2 = detectVagueFood('I ate kfc');
    expect(r1.response).toBe(r2.response);
  });
});

describe('detectVagueFood — uber-vague quantity guard (QA report 2026-06-03)', () => {
  it('flags "I ate a whole pizza" as vague (the screenshot failure)', () => {
    const r = detectVagueFood('I ate a whole pizza last night');
    expect(r.vague).toBe(true);
  });

  it('flags "I ate a whole cake" as vague even though cake is not in VAGUE_CATEGORIES', () => {
    const r = detectVagueFood('I ate a whole cake');
    expect(r.vague).toBe(true);
  });

  it('flags "tons of cookies" as vague', () => {
    const r = detectVagueFood('I had tons of cookies after dinner');
    expect(r.vague).toBe(true);
  });

  it('flags "way too much ice cream" as vague', () => {
    const r = detectVagueFood('I had way too much ice cream');
    expect(r.vague).toBe(true);
  });

  it('flags "a loaf of bread" as vague', () => {
    const r = detectVagueFood('I ate a loaf of bread');
    expect(r.vague).toBe(true);
  });

  it('still passes specific portions ("3 slices of pizza")', () => {
    const r = detectVagueFood('I had 3 slices of pizza');
    expect(r.vague).toBe(false);
  });

  it('still passes "a medium pizza" (reasonable estimate possible)', () => {
    const r = detectVagueFood('I had a medium pizza');
    expect(r.vague).toBe(false);
  });

  // ── 2026-06-11 WhatsApp screenshot: considering food ≠ eaten food ────────
  describe('consideration framing is NOT a vague food log (2026-06-11)', () => {
    const considerations = [
      'How about pizza for dinner?',
      'What about a burger?',
      'Should I have pizza tonight?',
      'Thinking about getting sushi',
      'Maybe I should order pasta',
      'Can I have a burrito?',
      'Is pizza ok on a GLP-1?',
    ];
    for (const c of considerations) {
      it(`"${c}" → not vague`, () => {
        expect(detectVagueFood(c).vague).toBe(false);
      });
    }

    it('still flags an actual past-tense vague log ("I ate pizza")', () => {
      expect(detectVagueFood('I ate pizza').vague).toBe(true);
    });
  });

  // ── 2026-06-13 expanded vague categories ────────────────────────────────────
  describe('expanded vague categories', () => {
    const vague = [
      'I had a casserole', 'I had a poke bowl', 'I had noodles', 'I had ramen',
      'I had an omelette', 'I had an omelet', 'I had a smoothie',
      'I had a milkshake', 'I had stew', 'I had a salad',
    ];
    for (const m of vague) {
      it(`"${m}" → vague`, () => expect(detectVagueFood(m).vague).toBe(true));
    }

    // Naming the filling/protein makes the category specific enough to log.
    // ("a bowl of X" is specific — the portion is given; "large pasta" stays
    // vague because pasta protein hinges on sauce/meat, not size.)
    const specific = [
      'cheese omelette', 'veggie omelette', 'chicken noodles', 'beef stew',
      'chicken casserole', 'a bowl of oatmeal', 'chicken salad', 'chicken pasta',
    ];
    for (const m of specific) {
      it(`"${m}" → not vague`, () => expect(detectVagueFood(m).vague).toBe(false));
    }
  });

  // ── 2026-06-13 prep-method clarification (fried/sauce-heavy) ─────────────────
  describe('prep-method clarification', () => {
    const needsPrep = ['I had chicken', 'I had fish', 'chicken', 'I ate salmon', 'shrimp', 'I had pork'];
    for (const m of needsPrep) {
      it(`"${m}" → asks about prep`, () => {
        const r = detectVagueFood(m);
        expect(r.vague).toBe(true);
        expect(r.response).toMatch(/grilled, baked, or fried|prepared/i);
        expect(r.response).toMatch(/calories/i); // continuation gate needs this + '?'
      });
    }

    const enough = [
      'grilled chicken', 'fried fish', 'baked salmon', 'chicken with bbq sauce',
      'chicken breast',             // named cut → log
      'chicken and rice',           // multi-item → not a single bare food
      '6 oz of salmon',             // quantity given
      'mashed potatoes',            // prep given
    ];
    for (const m of enough) {
      it(`"${m}" → no prep ask`, () => expect(detectVagueFood(m).vague).toBe(false));
    }
  });
});
