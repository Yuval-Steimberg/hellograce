export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface Bucket {
  failures: number;
  windowStart: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private bucket: Bucket = { failures: 0, windowStart: Date.now() };
  private openedAt = 0;

  constructor(
    private readonly opts: {
      failureThreshold: number;  // failures before opening
      windowMs: number;          // rolling window
      cooldownMs: number;        // how long to stay OPEN before HALF_OPEN
    } = { failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000 },
  ) {}

  get currentState(): CircuitState {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt >= this.opts.cooldownMs) {
        this.state = 'HALF_OPEN';
      }
    }
    return this.state;
  }

  isAllowed(): boolean {
    return this.currentState !== 'OPEN';
  }

  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.bucket = { failures: 0, windowStart: Date.now() };
    }
  }

  recordFailure(): void {
    const now = Date.now();
    if (now - this.bucket.windowStart > this.opts.windowMs) {
      this.bucket = { failures: 0, windowStart: now };
    }
    this.bucket.failures++;
    if (this.state === 'HALF_OPEN' || this.bucket.failures >= this.opts.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = now;
    }
  }
}
