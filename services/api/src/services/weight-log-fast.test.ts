import { describe, it, expect, vi } from 'vitest';
import { parseWeight, tryWeightLogFastResponse } from './weight-log-fast.js';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

function mockPool(rows: { weight_lbs: number }[] = []): any {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('INSERT')) return Promise.resolve({ rowCount: 1, rows: [] });
      return Promise.resolve({ rows });
    }),
  };
}

describe('parseWeight', () => {
  it('parses bare numbers as lbs', () => {
    expect(parseWeight('185')).toEqual({ lbs: 185 });
    expect(parseWeight('184.6')).toEqual({ lbs: 184.6 });
  });

  it('parses with explicit lbs/pounds unit', () => {
    expect(parseWeight('185 lbs')).toEqual({ lbs: 185 });
    expect(parseWeight('180 pounds')).toEqual({ lbs: 180 });
  });

  it('converts kg to lbs', () => {
    expect(parseWeight('80 kg')).toEqual({ lbs: 176.4 });
    expect(parseWeight('100 kilos')).toEqual({ lbs: 220.5 });
  });

  it('converts stone (+ optional pounds) to lbs', () => {
    expect(parseWeight('12 st')).toEqual({ lbs: 168 });
    expect(parseWeight('12 stone 6')).toEqual({ lbs: 174 });
    expect(parseWeight('13 st 4 lb')).toEqual({ lbs: 186 });
  });

  it('parses inside a sentence', () => {
    expect(parseWeight('I weigh 185 lbs')).toEqual({ lbs: 185 });
    expect(parseWeight('scale says 184.6')).toEqual({ lbs: 184.6 });
    expect(parseWeight('I am 200')).toEqual({ lbs: 200 });
  });

  it('rejects values outside human range', () => {
    expect(parseWeight('50')).toBeNull();     // too light
    expect(parseWeight('700')).toBeNull();    // too heavy
    expect(parseWeight('2024')).toBeNull();   // year
    expect(parseWeight('10 lbs')).toBeNull(); // too light
  });

  it('returns null on no number', () => {
    expect(parseWeight('hello there')).toBeNull();
    expect(parseWeight('I ate eggs')).toBeNull();
  });
});

describe('tryWeightLogFastResponse', () => {
  it('returns null when intent is not weight_log', async () => {
    const r = await tryWeightLogFastResponse('185 lbs', {
      pool: mockPool() as any,
      logger: noopLogger,
      userId: 'u1',
      intentType: 'food_log',
    });
    expect(r).toBeNull();
  });

  it('inserts + returns first-time template when no prior weight', async () => {
    const r = await tryWeightLogFastResponse('185 lbs', {
      pool: mockPool([]) as any,
      logger: noopLogger,
      userId: 'u1',
      intentType: 'weight_log',
    });
    expect(r).not.toBeNull();
    expect(r!.weightLbs).toBe(185);
    expect(r!.previousLbs).toBeNull();
    expect(r!.text).toContain('185');
  });

  it('reports loss when current < previous', async () => {
    const r = await tryWeightLogFastResponse('183', {
      pool: mockPool([{ weight_lbs: 185 }]) as any,
      logger: noopLogger,
      userId: 'u1',
      intentType: 'weight_log',
    });
    expect(r).not.toBeNull();
    expect(r!.text).toMatch(/(less|down)/);
    expect(r!.text).toContain('2 lbs');
  });

  it('reports flat when difference < 0.5', async () => {
    const r = await tryWeightLogFastResponse('185.2', {
      pool: mockPool([{ weight_lbs: 185 }]) as any,
      logger: noopLogger,
      userId: 'u1',
      intentType: 'weight_log',
    });
    expect(r!.text.toLowerCase()).toMatch(/steady|same/);
  });

  it('rejects messages with question mark', async () => {
    const r = await tryWeightLogFastResponse('185 lbs?', {
      pool: mockPool() as any,
      logger: noopLogger,
      userId: 'u1',
      intentType: 'weight_log',
    });
    expect(r).toBeNull();
  });

  it('rejects messages with negation/correction', async () => {
    const r = await tryWeightLogFastResponse("actually 184, sorry", {
      pool: mockPool() as any,
      logger: noopLogger,
      userId: 'u1',
      intentType: 'weight_log',
    });
    expect(r).toBeNull();
  });

  it('rejects long compound messages', async () => {
    const long = 'I weigh 185 lbs but I also ate breakfast which was eggs and toast and coffee';
    const r = await tryWeightLogFastResponse(long, {
      pool: mockPool() as any,
      logger: noopLogger,
      userId: 'u1',
      intentType: 'weight_log',
    });
    expect(r).toBeNull();
  });
});
