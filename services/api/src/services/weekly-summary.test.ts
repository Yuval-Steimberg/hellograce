import { describe, it, expect } from 'vitest';
import {
  detectSummaryRequest,
  mightBeSummaryRequest,
  gatherWeeklySummary,
  renderWeeklySummary,
  looksEncrypted,
  type WeeklySummaryDeps,
  type WeeklySummaryUser,
  type WeeklySummaryData,
} from './weekly-summary.js';

// ─── Detection ────────────────────────────────────────────────────────────────

describe('detectSummaryRequest', () => {
  it('fires on the production opener "summary of how my last week was"', () => {
    expect(
      detectSummaryRequest(
        'I have an appointment with my doctor tomorrow can i you give me a summary of how my last week was?',
      ),
    ).toBe(true);
  });

  it('fires on the production continuation "Add all the data you have to make it comprehensive"', () => {
    expect(detectSummaryRequest('Add all the data you have to make it comprehensive')).toBe(true);
  });

  it('fires on "make it comprehensive" standalone', () => {
    expect(detectSummaryRequest('make it comprehensive')).toBe(true);
  });

  it('fires on "how has my week been"', () => {
    expect(detectSummaryRequest('how has my week been')).toBe(true);
  });

  it('fires on "recap my week for my doctor"', () => {
    expect(detectSummaryRequest('recap my week for my doctor')).toBe(true);
  });

  it('fires on "summarize my progress"', () => {
    expect(detectSummaryRequest('summarize my progress so far')).toBe(true);
  });

  it('does NOT hijack a single-day food question', () => {
    expect(detectSummaryRequest('what did I eat today')).toBe(false);
    expect(detectSummaryRequest("how much protein have I had today")).toBe(false);
  });

  it('does NOT fire on a plain food log', () => {
    expect(detectSummaryRequest('I had chicken and rice for lunch')).toBe(false);
  });

  it('does NOT fire on appointment QUESTION requests (those keep the questions path)', () => {
    expect(detectSummaryRequest('help me write my questions for my endocrinologist appointment')).toBe(false);
    expect(detectSummaryRequest('what should I ask my doctor')).toBe(false);
  });

  it('weak continuation only fires inside an active summary context', () => {
    expect(detectSummaryRequest('expand on that')).toBe(false);
    expect(
      detectSummaryRequest('expand on that', 'Here is your weekly summary, you averaged 60g protein'),
    ).toBe(true);
    // Weak phrase but unrelated prior context → no fire.
    expect(detectSummaryRequest('expand on that', 'I had eggs for breakfast')).toBe(false);
  });
});

describe('mightBeSummaryRequest (cheap pre-gate)', () => {
  it('is true for the strong forms', () => {
    expect(mightBeSummaryRequest('summary of my last week')).toBe(true);
    expect(mightBeSummaryRequest('add all the data you have')).toBe(true);
  });
  it('is true for weak continuation (resolved later with context)', () => {
    expect(mightBeSummaryRequest('expand on that')).toBe(true);
  });
  it('is false for ordinary messages', () => {
    expect(mightBeSummaryRequest('I feel tired today')).toBe(false);
    expect(mightBeSummaryRequest('I had a protein shake')).toBe(false);
  });
});

// ─── Gathering ────────────────────────────────────────────────────────────────

const now = new Date('2026-06-18T12:00:00.000Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 3_600_000);

const user: WeeklySummaryUser = {
  phone: '+15551234567',
  first_name: 'Sam',
  medication: 'wegovy',
  dose_mg: 0.5,
  injection_day: 'Sunday',
  protein_goal_grams: 80,
  side_effect_flow: null,
  side_effect_flow_started_at: null,
};

function makeDeps(over: Partial<WeeklySummaryDeps> = {}): WeeklySummaryDeps {
  return {
    getDailyProteinHistory: async () => [
      { day: '2026-06-18', protein_g: 70, calories: 1500, item_count: 3 },
      { day: '2026-06-17', protein_g: 60, calories: 1400, item_count: 2 },
      { day: '2026-06-16', protein_g: 0, calories: 0, item_count: 0 },
    ],
    getWeightHistory: async () => [
      { weight: 196, created_at: daysAgo(1) },
      { weight: 198, created_at: daysAgo(6) },
      { weight: 205, created_at: daysAgo(40) }, // out of window, ignored
    ],
    getRecentCheckIns: async () => [
      { type: 'mood_log', mood_score: 6, created_at: daysAgo(1) },
      { type: 'mood_log', mood_score: 8, created_at: daysAgo(3) },
      { type: 'morning', mood_score: null, created_at: daysAgo(2) },
      { type: 'mood_log', mood_score: 2, created_at: daysAgo(40) }, // out of window
    ],
    ...over,
  };
}

describe('gatherWeeklySummary', () => {
  it('aggregates only days that were logged and only in-window weight/mood', async () => {
    const data = await gatherWeeklySummary(makeDeps(), user, now);
    expect(data.daysLogged).toBe(2);
    expect(data.avgProtein).toBe(65); // (70 + 60) / 2
    expect(data.avgCalories).toBe(1450); // (1500 + 1400) / 2
    expect(data.weightStart).toBe(198);
    expect(data.weightLatest).toBe(196);
    expect(data.avgMood).toBe(7); // (6 + 8) / 2, the 40-day-old 2 is excluded
    expect(data.medication).toBe('wegovy');
    expect(data.doseMg).toBe(0.5);
    expect(data.injectionDay).toBe('Sunday');
  });

  it('includes an active side-effect flag inside the window', async () => {
    const data = await gatherWeeklySummary(
      makeDeps(),
      { ...user, side_effect_flow: 'nausea', side_effect_flow_started_at: daysAgo(2) },
      now,
    );
    expect(data.sideEffect).toBe('nausea');
  });

  it('ignores an old side-effect flag outside the window', async () => {
    const data = await gatherWeeklySummary(
      makeDeps(),
      { ...user, side_effect_flow: 'fatigue', side_effect_flow_started_at: daysAgo(30) },
      now,
    );
    expect(data.sideEffect).toBeNull();
  });

  it('never leaks an undecrypted medication blob (encryption key missing/rotated)', async () => {
    const blob = 'enc:0b5f95fcc08abfd1d100b3bbf8:9fc0bd0f16e13c33736d4:e869b61ae8988e421a3b221721444616';
    const data = await gatherWeeklySummary(
      makeDeps(),
      { ...user, medication: blob },
      now,
    );
    expect(data.medication).toBeNull();
    // The dose still renders, just without the ciphertext medication name.
    const out = renderWeeklySummary(data);
    expect(out).not.toContain('enc:');
    expect(out).toContain('0.5mg');
  });

  it('degrades gracefully when a source throws', async () => {
    const data = await gatherWeeklySummary(
      makeDeps({
        getWeightHistory: async () => { throw new Error('db down'); },
      }),
      user,
      now,
    );
    expect(data.weightLatest).toBeNull();
    expect(data.daysLogged).toBe(2); // other sources still work
  });
});

// ─── Rendering ────────────────────────────────────────────────────────────────

describe('looksEncrypted', () => {
  it('flags an enc:<iv>:<data>:<tag> blob', () => {
    expect(looksEncrypted('enc:0b5f95fcc08abfd1d100b3bbf8:9fc0bd0f16:e869b61ae8988e421a3b221721444616')).toBe(true);
    expect(looksEncrypted('ENC:0b5f95fcc08abfd1:9fc0bd0f16:e869b61a')).toBe(true);
  });
  it('does not flag a real medication name', () => {
    expect(looksEncrypted('Wegovy')).toBe(false);
    expect(looksEncrypted('semaglutide')).toBe(false);
    expect(looksEncrypted(null)).toBe(false);
    expect(looksEncrypted(undefined)).toBe(false);
  });
});

describe('renderWeeklySummary', () => {
  const fullData: WeeklySummaryData = {
    daysWindow: 7,
    daysLogged: 5,
    avgProtein: 68,
    avgCalories: 1540,
    proteinGoal: 80,
    weightStart: 198,
    weightLatest: 196,
    avgMood: 6,
    medication: 'wegovy',
    doseMg: 0.5,
    injectionDay: 'Sunday',
    sideEffect: 'nausea',
  };

  it('covers every data point in clean prose', () => {
    const out = renderWeeklySummary(fullData);
    expect(out).toContain('5 of 7 days');
    expect(out).toContain('68g protein');
    expect(out).toContain('1,540 calories');
    expect(out).toContain('198 to 196 lbs');
    expect(out).toContain('6 out of 10');
    expect(out).toContain('Wegovy');
    expect(out).toContain('0.5mg');
    expect(out).toContain('Sunday');
    expect(out).toContain('nausea');
    expect(out).toContain('doctor');
  });

  it('reflects the week, never a single day', () => {
    const out = renderWeeklySummary(fullData);
    expect(out).toContain('Over the last 7 days');
    expect(out).not.toMatch(/\btoday\b/i);
  });

  it('is enforcer-safe: no headers, no bullets, no label-colons, no markdown', () => {
    const out = renderWeeklySummary(fullData);
    expect(out).not.toContain('\n');
    expect(out).not.toMatch(/^[A-Z][a-z]+:/m); // "Overall Trends:" style header
    expect(out).not.toMatch(/[•*\-]\s/); // bullets
    expect(out).not.toContain(':;');
    expect(out).not.toContain('**');
  });

  it('stays within the outbound ~420-char cap', () => {
    expect(renderWeeklySummary(fullData).length).toBeLessThanOrEqual(420);
  });

  it('omits lines it has no data for (never fabricates)', () => {
    const out = renderWeeklySummary({
      daysWindow: 7,
      daysLogged: 3,
      avgProtein: 55,
      avgCalories: null,
      proteinGoal: null,
      weightStart: null,
      weightLatest: null,
      avgMood: null,
      medication: 'mounjaro',
      doseMg: null,
      injectionDay: null,
      sideEffect: null,
    });
    expect(out).toContain('55g protein');
    expect(out).not.toMatch(/lbs/);
    expect(out).not.toMatch(/out of 10/);
    expect(out).toContain('Mounjaro');
  });

  it('gives an honest, useful answer when nothing is logged', () => {
    const out = renderWeeklySummary({
      daysWindow: 7,
      daysLogged: 0,
      avgProtein: null,
      avgCalories: null,
      proteinGoal: null,
      weightStart: null,
      weightLatest: null,
      avgMood: null,
      medication: null,
      doseMg: null,
      injectionDay: null,
      sideEffect: null,
    });
    expect(out).toMatch(/don'?t have much logged/i);
    expect(out).toMatch(/doctor/i);
  });
});
