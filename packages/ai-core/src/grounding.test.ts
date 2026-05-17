import { describe, expect, it } from 'vitest';
import type { RetrievedDoc } from '@grace/shared';
import { precheckGrounding, summarizeUnsupported } from './grounding.js';

function doc(content: string, id = 'doc-1'): RetrievedDoc {
  return { id, source: 'knowledge', content, score: 0.9 };
}

describe('precheckGrounding', () => {
  it('detects nothing in plain conversational text', () => {
    const r = precheckGrounding("Sounds good — let me know how it goes.", []);
    expect(r.detected).toHaveLength(0);
    expect(r.unsupported).toHaveLength(0);
  });

  it('flags a dose claim when no knowledge context is available', () => {
    const r = precheckGrounding('Take 2mg twice a week.', []);
    expect(r.detected.some((c) => c.kind === 'dose')).toBe(true);
    expect(r.unsupported.length).toBeGreaterThan(0);
  });

  it('accepts a dose claim that appears verbatim in retrieved knowledge', () => {
    const r = precheckGrounding(
      'The standard maintenance dose is 2.4 mg weekly.',
      [doc('Wegovy maintenance dose is 2.4 mg once weekly after titration.')],
    );
    expect(r.detected.some((c) => c.kind === 'dose')).toBe(true);
    expect(r.unsupported).toHaveLength(0);
  });

  it('does NOT flag a duration like "6 weeks" — removed to reduce false positives on nutrition advice', () => {
    const r = precheckGrounding('You should see results in 6 weeks.', [doc('GLP-1s reduce appetite.')]);
    expect(r.detected.some((c) => c.kind === 'dose')).toBe(false);
    expect(r.unsupported).toHaveLength(0);
  });

  it('does NOT flag exercise frequency like "twice a week" — only drug doses trigger grounding', () => {
    const r = precheckGrounding('Try resistance training twice a week.', []);
    expect(r.detected).toHaveLength(0);
  });

  it('flags a percentage weight-loss claim without KB support', () => {
    const r = precheckGrounding('Most patients lose 15% of their body weight.', []);
    expect(r.detected.some((c) => c.kind === 'percentage')).toBe(true);
    expect(r.unsupported.length).toBeGreaterThan(0);
  });

  it('flags an interaction-safety assertion', () => {
    const r = precheckGrounding("It's safe to combine ibuprofen with semaglutide.", []);
    expect(r.detected.some((c) => c.kind === 'interaction')).toBe(true);
    expect(r.unsupported.length).toBeGreaterThan(0);
  });

  it('accepts an interaction phrase when KB discusses interactions', () => {
    const r = precheckGrounding("It's safe to take Tylenol.", [
      doc('Acetaminophen does not have a known interaction with semaglutide.'),
    ]);
    expect(r.unsupported).toHaveLength(0);
  });

  it('soft-matches a numeric value across phrasing variants', () => {
    const r = precheckGrounding(
      'Studies show a 15% reduction.',
      [doc('Clinical trials report up to 15 percent reduction in body weight.')],
    );
    expect(r.unsupported).toHaveLength(0);
  });

  it('does not flag a drug name mentioned without a quantitative claim', () => {
    const r = precheckGrounding(
      'Got it — you mentioned you started Ozempic last month.',
      [doc('Patient profile')],
    );
    expect(r.detected).toHaveLength(0);
  });
});

describe('summarizeUnsupported', () => {
  it('renders empty list when no claims', () => {
    expect(summarizeUnsupported([])).toEqual([]);
  });

  it('caps at four claims', () => {
    const claims = [
      { kind: 'dose' as const, text: '1mg' },
      { kind: 'dose' as const, text: '2mg' },
      { kind: 'dose' as const, text: '3mg' },
      { kind: 'dose' as const, text: '4mg' },
      { kind: 'dose' as const, text: '5mg' },
    ];
    expect(summarizeUnsupported(claims)).toHaveLength(4);
  });

  it('describes each claim with kind and verbatim text', () => {
    const lines = summarizeUnsupported([{ kind: 'interaction', text: 'safe to combine' }]);
    expect(lines[0]).toContain('interaction');
    expect(lines[0]).toContain('safe to combine');
  });
});
