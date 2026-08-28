export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

export interface FixedWindowRateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
  readonly now?: () => number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

/**
 * A process-local fixed-window limiter with bounded, least-recently-used key storage.
 * Calls are synchronous so admission remains atomic across concurrent request handlers.
 */
export class FixedWindowRateLimiter {
  readonly #entries = new Map<string, WindowEntry>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;

  public constructor(options: FixedWindowRateLimiterOptions) {
    this.#limit = positiveInteger(options.limit, "limit");
    this.#windowMs = positiveInteger(options.windowMs, "windowMs");
    this.#maxKeys = positiveInteger(options.maxKeys, "maxKeys");
    this.#now = options.now ?? Date.now;
  }

  public get size(): number {
    return this.#entries.size;
  }

  public consume(key: string): RateLimitDecision {
    const now = this.#now();
    this.#pruneExpired(now);
    const existing = this.#entries.get(key);

    if (existing && existing.resetAt > now) {
      this.#touch(key, existing);
      if (existing.count >= this.#limit) {
        return { allowed: false, retryAfterSeconds: this.#retryAfter(existing.resetAt, now) };
      }
      existing.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (existing) this.#entries.delete(key);
    this.#makeRoom();
    this.#entries.set(key, { count: 1, resetAt: now + this.#windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  public reset(key: string): void {
    this.#entries.delete(key);
  }

  #retryAfter(resetAt: number, now: number): number {
    const remaining = Math.min(this.#windowMs, Math.max(1, resetAt - now));
    return Math.max(1, Math.ceil(remaining / 1_000));
  }

  #touch(key: string, entry: WindowEntry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  #pruneExpired(now: number): void {
    // Touched entries move to the end, so expired and idle entries naturally
    // accumulate near the front. Bound cleanup work per request as well as memory.
    let inspected = 0;
    for (const [key, entry] of this.#entries) {
      if (inspected >= 32) break;
      inspected += 1;
      if (entry.resetAt <= now) this.#entries.delete(key);
    }
  }

  #makeRoom(): void {
    while (this.#entries.size >= this.#maxKeys) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      this.#entries.delete(oldest.value);
    }
  }
}

export class ConcurrencyGate {
  #active = 0;
  readonly #limit: number;

  public constructor(limit: number) {
    this.#limit = positiveInteger(limit, "concurrency limit");
  }

  public get active(): number {
    return this.#active;
  }

  public tryAcquire(): (() => void) | null {
    if (this.#active >= this.#limit) return null;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }
}
