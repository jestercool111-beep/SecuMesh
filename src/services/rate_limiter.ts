export class InMemoryRateLimiter {
  readonly #windowMs: number;
  readonly #maxRequests: number;
  readonly #requests = new Map<string, number[]>();

  constructor(windowMs: number, maxRequests: number) {
    this.#windowMs = windowMs;
    this.#maxRequests = maxRequests;
  }

  check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const windowStart = now - this.#windowMs;
    const bucket = (this.#requests.get(key) ?? []).filter((ts) => ts >= windowStart);

    bucket.push(now);
    this.#requests.set(key, bucket);

    const allowed = bucket.length <= this.#maxRequests;
    const remaining = Math.max(0, this.#maxRequests - bucket.length);
    const resetAt = (bucket[0] ?? now) + this.#windowMs;

    return { allowed, remaining, resetAt };
  }
}
