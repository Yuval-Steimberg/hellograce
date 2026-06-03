/**
 * Per-request stage-timing tracker. Stack-based, zero-cost when not used.
 *
 * The orchestration pipeline has ~10 stages whose individual costs matter
 * (parallel I/O, vague-food guard, FAQ cache lookup, force-detection,
 * planner+rag, prompt build, orchestrator generate, post-gen guards, regen,
 * persist). Tracking each gives us the breakdown we need to find slow
 * paths instead of guessing from totals.
 *
 * Usage:
 *
 *   const lat = new LatencyTracker();
 *   lat.mark('parallel_io');
 *   await Promise.all([...]);
 *   lat.mark('vague_food');
 *   ...
 *   const timings = lat.snapshot();           // for telemetry
 *   logger.info({ stages: timings }, 'ai.handle.latency');
 *
 * Each mark closes the PREVIOUS span and opens a new one. The final span
 * is closed implicitly by snapshot() or end(). Span names should be stable
 * — they become column keys in the `stage_timings JSONB` column.
 */

export interface StageTimings {
  [stage: string]: number;
}

export class LatencyTracker {
  private readonly t0 = Date.now();
  private timings: StageTimings = {};
  private currentStage: string | null = null;
  private currentStart = this.t0;

  /** Close the current span (if any) and open a new one. */
  mark(stage: string): void {
    const now = Date.now();
    if (this.currentStage) {
      const existing = this.timings[this.currentStage] ?? 0;
      this.timings[this.currentStage] = existing + (now - this.currentStart);
    }
    this.currentStage = stage;
    this.currentStart = now;
  }

  /** Close the current span without starting a new one. */
  end(): void {
    if (this.currentStage) {
      const now = Date.now();
      const existing = this.timings[this.currentStage] ?? 0;
      this.timings[this.currentStage] = existing + (now - this.currentStart);
      this.currentStage = null;
    }
  }

  /** Get a copy of all timings collected so far (closes current span). */
  snapshot(): StageTimings {
    this.end();
    return { ...this.timings };
  }

  /** Total elapsed since the tracker was created. */
  totalMs(): number {
    return Date.now() - this.t0;
  }
}

/**
 * Per-intent latency targets used by slow-request alerting.
 * Beyond these thresholds we log `ai.handle.slow_response` with the full
 * stage breakdown so the issue can be diagnosed without re-instrumenting.
 *
 * Targets (per the 2026-06-03 latency directive):
 *   - Simple/trivial: <1000ms
 *   - Standard coaching: <2000ms
 *   - Complex (knowledge, food_question with RAG, appointment_prep): <3000ms
 *
 * These are TARGETS, not SLOs. We log breaches; we don't fail requests.
 */
export const LATENCY_TARGETS_MS: Record<string, number> = {
  // Trivial — fast-path hit or deterministic
  fast_path: 1000,
  food_log_fast: 1000,
  greeting: 1000,
  gibberish: 1000,
  // Standard coaching
  food_log: 2000,
  weight_log: 2000,
  mood_log: 2000,
  emotional: 2000,
  exercise_log: 2000,
  injection_log: 2000,
  social_situation: 2000,
  scheduling: 2000,
  pause_request: 2000,
  // Complex — need RAG / multi-tool / longer generation
  knowledge: 3000,
  medication_question: 3000,
  food_question: 3000,
  appointment_prep: 3000,
  general: 3000,
};

/** Default target for any intent not in the table above. */
export const DEFAULT_LATENCY_TARGET_MS = 3000;
