import { describe, it, expect } from 'vitest';
import { buildDoseTimeline, type DoseEvent, type WeightEntry, type SymptomEntry } from './medication-timeline.js';

const NOW = new Date('2026-07-05T12:00:00Z');
const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe('buildDoseTimeline', () => {
  it('builds ordered periods with correct from/to and current flag', () => {
    const events: DoseEvent[] = [
      { medication: 'zepbound', dose_mg: 2.5, effective_date: '2026-05-01' },
      { medication: 'zepbound', dose_mg: 5, effective_date: '2026-06-01' },
    ];
    const t = buildDoseTimeline(events, [], [], { glp1_start_date: '2026-05-01' }, NOW);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ doseMg: 2.5, from: '2026-05-01', to: '2026-06-01', current: false });
    expect(t[1]).toMatchObject({ doseMg: 5, from: '2026-06-01', to: null, current: true });
    expect(t[0]!.glp1WeekStart).toBe(1);
  });

  it('computes weight change within each dose period', () => {
    const events: DoseEvent[] = [
      { medication: 'x', dose_mg: 2.5, effective_date: '2026-05-01' },
      { medication: 'x', dose_mg: 5, effective_date: '2026-06-01' },
    ];
    const weights: WeightEntry[] = [
      { weight: 210, created_at: d('2026-05-02') },
      { weight: 205, created_at: d('2026-05-28') }, // period 1: -5
      { weight: 204, created_at: d('2026-06-03') },
      { weight: 199, created_at: d('2026-06-30') }, // period 2: -5
    ];
    const t = buildDoseTimeline(events, weights, [], {}, NOW);
    expect(t[0]!.weightDeltaLbs).toBe(-5);
    expect(t[1]!.weightDeltaLbs).toBe(-5);
  });

  it('reports the top symptom per period', () => {
    const events: DoseEvent[] = [
      { medication: 'x', dose_mg: 2.5, effective_date: '2026-05-01' },
      { medication: 'x', dose_mg: 5, effective_date: '2026-06-01' },
    ];
    const symptoms: SymptomEntry[] = [
      { symptom: 'nausea', created_at: d('2026-05-05') },
      { symptom: 'nausea', created_at: d('2026-05-10') },
      { symptom: 'fatigue', created_at: d('2026-05-12') }, // period 1 top: nausea
      { symptom: 'constipation', created_at: d('2026-06-10') }, // period 2 top: constipation
    ];
    const t = buildDoseTimeline(events, [], symptoms, {}, NOW);
    expect(t[0]!.topSymptom).toBe('nausea');
    expect(t[1]!.topSymptom).toBe('constipation');
  });

  it('synthesizes a current-dose period when nothing is recorded', () => {
    const t = buildDoseTimeline([], [{ weight: 200, created_at: d('2026-04-01') }], [], {
      medication: 'wegovy',
      dose_mg: 1.0,
      glp1_start_date: '2026-04-01',
    }, NOW);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ doseMg: 1.0, medication: 'wegovy', from: '2026-04-01', current: true });
  });

  it('returns [] when there are no events and no current dose', () => {
    expect(buildDoseTimeline([], [], [], { dose_mg: null }, NOW)).toEqual([]);
  });

  it('is null-safe for weight delta with a single weigh-in in a period', () => {
    const events: DoseEvent[] = [{ medication: 'x', dose_mg: 2.5, effective_date: '2026-05-01' }];
    const t = buildDoseTimeline(events, [{ weight: 200, created_at: d('2026-05-10') }], [], {}, NOW);
    expect(t[0]!.weightDeltaLbs).toBeNull();
  });
});
