import { describe, it, expect } from 'vitest';
import { LatencyTracker, LATENCY_TARGETS_MS, DEFAULT_LATENCY_TARGET_MS } from './latency-tracker.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('LatencyTracker', () => {
  it('captures a single stage', async () => {
    const lat = new LatencyTracker();
    lat.mark('stage_a');
    await sleep(20);
    const snap = lat.snapshot();
    expect(snap['stage_a']).toBeGreaterThanOrEqual(15);
    expect(snap['stage_a']).toBeLessThan(150);
  });

  it('captures multiple stages with mark() transitions', async () => {
    const lat = new LatencyTracker();
    lat.mark('stage_a');
    await sleep(20);
    lat.mark('stage_b');
    await sleep(20);
    lat.mark('stage_c');
    await sleep(10);
    const snap = lat.snapshot();
    expect(snap['stage_a']).toBeGreaterThanOrEqual(15);
    expect(snap['stage_b']).toBeGreaterThanOrEqual(15);
    expect(snap['stage_c']).toBeGreaterThanOrEqual(5);
  });

  it('accumulates time when the same stage is marked twice', async () => {
    const lat = new LatencyTracker();
    lat.mark('stage_a');
    await sleep(20);
    lat.mark('stage_b');
    await sleep(10);
    lat.mark('stage_a');
    await sleep(20);
    const snap = lat.snapshot();
    expect(snap['stage_a']).toBeGreaterThanOrEqual(35);
    expect(snap['stage_b']).toBeGreaterThanOrEqual(5);
  });

  it('snapshot() closes the open span', async () => {
    const lat = new LatencyTracker();
    lat.mark('stage_x');
    await sleep(15);
    const snap = lat.snapshot();
    expect(snap['stage_x']).toBeGreaterThanOrEqual(10);
  });

  it('end() closes the open span without starting a new one', async () => {
    const lat = new LatencyTracker();
    lat.mark('stage_x');
    await sleep(15);
    lat.end();
    await sleep(15);
    const snap = lat.snapshot();
    expect(snap['stage_x']).toBeGreaterThanOrEqual(10);
    expect(snap['stage_x']).toBeLessThan(80);
  });

  it('totalMs() reports elapsed since construction', async () => {
    const lat = new LatencyTracker();
    await sleep(20);
    expect(lat.totalMs()).toBeGreaterThanOrEqual(15);
  });

  it('snapshot returns a copy (mutations do not affect the tracker)', () => {
    const lat = new LatencyTracker();
    lat.mark('a');
    lat.mark('b');
    const snap = lat.snapshot();
    snap['a'] = 999_999;
    const snap2 = lat.snapshot();
    expect(snap2['a']).not.toBe(999_999);
  });

  it('exposes per-intent latency targets and a default', () => {
    expect(LATENCY_TARGETS_MS.fast_path).toBe(1000);
    expect(LATENCY_TARGETS_MS.food_log).toBe(2000);
    expect(LATENCY_TARGETS_MS.knowledge).toBe(3000);
    expect(LATENCY_TARGETS_MS.appointment_prep).toBe(3000);
    expect(DEFAULT_LATENCY_TARGET_MS).toBe(3000);
  });
});
