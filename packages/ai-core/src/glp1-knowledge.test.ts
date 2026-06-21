import { describe, it, expect } from 'vitest';
import { answerGlp1Topic, answerGlp1Topics, matchGlp1Topic, normalizeKnowledgeText } from './glp1-knowledge.js';

describe('answerGlp1Topics — multi-part questions answer every part', () => {
  it('covers alcohol + protein in one reply (production 2026-06-21)', () => {
    const out = answerGlp1Topics('Can I drink alcohol and also how much protein and why is my weight') ?? '';
    expect(out.toLowerCase()).toContain('alcohol');
    expect(out.toLowerCase()).toContain('protein');
    expect(out.length).toBeGreaterThan(150);
  });

  it('a single-topic question returns exactly the single answer', () => {
    const single = answerGlp1Topic('is alcohol ok on ozempic');
    expect(answerGlp1Topics('is alcohol ok on ozempic')).toBe(single);
  });

  it('returns null for a non-health message', () => {
    expect(answerGlp1Topics('what is the weather and the news')).toBeNull();
  });
});

describe('answerGlp1Topic — comprehensive coverage', () => {
  const expectations: Array<[string, string]> = [
    ['is it possible that i feel that my muscles get smaller?', 'muscle'],
    ['how much protein should i eat', 'protein_target'],
    ['how much water should i drink', 'water'],
    ['can i drink alcohol on ozempic', 'alcohol'],
    ['is coffee ok', 'caffeine'],
    ['i have terrible constipation', 'constipation'],
    ['diarrhea after my shot', 'diarrhea'],
    ['really bad heartburn at night', 'heartburn'],
    ['so much bloating and gas', 'bloating_gas'],
    ['i keep throwing up', 'vomiting'],
    ['feeling nauseous all day', 'nausea'],
    ['how long do side effects last', 'side_effect_duration'],
    ['im exhausted and have no energy', 'fatigue'],
    ['i feel dizzy and lightheaded', 'dizziness'],
    ['constant headaches', 'headache'],
    ['hair is falling out', 'hair_loss'],
    ['is it possible that i feel that my hair is shorter?', 'hair_loss'],
    ['my hair feels different and thinner', 'hair_loss'],
    ['whats ozempic face', 'face_skin'],
    ['my appetite is gone, not hungry at all', 'food_noise'],
    ['feels like its wearing off before my next dose', 'appetite_return'],
    ['i forgot my dose what should i do', 'missed_dose'],
    ['when should i increase my dose', 'dose_increase'],
    ['where do i inject and does it bruise', 'injection_site'],
    ['what day should i take my shot', 'injection_timing'],
    ['do i need to refrigerate my pen when i travel', 'storage'],
    ['how does ozempic work', 'mechanism'],
    ['do i have to take this forever', 'how_long_take'],
    ['will i gain the weight back if i stop', 'weight_regain'],
    ['how much weight should i expect to lose', 'expected_loss'],
    ['am i ok to be pregnant on this', 'pregnancy'],
    ['does it affect birth control', 'birth_control'],
    ['how much fiber do i need', 'fiber'],
    ['should i take electrolytes', 'electrolytes'],
    ['my blood sugar keeps dropping', 'blood_sugar'],
    ['gallbladder pain', 'gallbladder'],
    ['cant sleep at night', 'sleep'],
    ['should i lift weights', 'exercise'],
    ['ive hit a plateau', 'plateau'],
  ];
  for (const [msg, topic] of expectations) {
    it(`"${msg}" → ${topic}`, () => {
      expect(matchGlp1Topic(msg)).toBe(topic);
      expect(answerGlp1Topic(msg)).toBeTruthy();
    });
  }
});

describe('answerGlp1Topic — typo tolerance', () => {
  const typos: Array<[string, string]> = [
    ['im so naus all the time', 'nausea'],
    ['how do i deal with constipaton', 'constipation'],
    ['i have diarhea', 'diarrhea'],
    ['is hair loose commn on glp', 'hair_loss'],
    ['my muscels feel smaller', 'muscle'],
    ['whats my protien target', 'protein_target'],
    ['bad hartburn', 'heartburn'],
    ['im bloted and gassy', 'bloating_gas'],
  ];
  for (const [msg, topic] of typos) {
    it(`typo "${msg}" → ${topic}`, () => {
      expect(matchGlp1Topic(msg)).toBe(topic);
    });
  }
});

describe('answerGlp1Topic — does not over-fire on non-health messages', () => {
  for (const msg of ['what should i watch tonight', 'who won the game', 'thanks so much', 'ok sounds good', 'i had pizza']) {
    it(`"${msg}" → null`, () => {
      expect(answerGlp1Topic(msg)).toBeNull();
    });
  }
});

describe('safety: missed-dose answer warns against doubling, never advises it', () => {
  it('tells the user NOT to double up', () => {
    const a = answerGlp1Topic('i missed my injection should i double up')!;
    expect(a).toMatch(/don'?t double up|skip/i);
    expect(a).not.toMatch(/take (an )?extra|double the dose|take double/i);
  });

  it('pregnancy defers to the doctor (no clinical instruction)', () => {
    const a = answerGlp1Topic('can i take this while pregnant')!;
    expect(a).toMatch(/doctor|prescriber|not recommended/i);
  });
});

describe('normalizeKnowledgeText', () => {
  it('collapses repeated letters and fixes typos', () => {
    expect(normalizeKnowledgeText('im sooooo nauseaous')).toContain('nause');
  });
});
