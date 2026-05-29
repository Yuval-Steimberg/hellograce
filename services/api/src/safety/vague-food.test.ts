import { describe, it, expect } from 'vitest';
import { detectVagueFood } from './vague-food.js';

describe('detectVagueFood — flags vague brand/category mentions', () => {
  it('flags the exact production bug case: "I ate kfc this morning it was delicious"', () => {
    const r = detectVagueFood('I ate kfc this morning it was delicious');
    expect(r.vague).toBe(true);
    expect(r.matched).toBe('kfc');
    expect(r.response).toMatch(/exactly|what.*order|specific|details/i);
    expect(r.response).toMatch(/kfc/i);
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
    expect(r.response).not.toMatch(/protein|calorie/i);
  });

  it('returns the same response for the same input (stable hash)', () => {
    const r1 = detectVagueFood('I ate kfc');
    const r2 = detectVagueFood('I ate kfc');
    expect(r1.response).toBe(r2.response);
  });
});
