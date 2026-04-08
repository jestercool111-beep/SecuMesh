import { RedisClient } from '../store/redis_client.ts';

export interface RateLimiter {
  check(keys: Array<{ key: string; limit: number }>): Promise<{
    allowed: boolean;
    remaining: number;
    resetAt: number;
    violatedKey?: string;
  }>;
}

export class InMemoryRateLimiter implements RateLimiter {
  readonly #windowMs: number;
  readonly #requests = new Map<string, number[]>();

  constructor(windowMs: number) {
    this.#windowMs = windowMs;
  }

  async check(keys: Array<{ key: string; limit: number }>): Promise<{
    allowed: boolean;
    remaining: number;
    resetAt: number;
    violatedKey?: string;
  }> {
    const now = Date.now();
    const windowStart = now - this.#windowMs;
    let mostRestrictive = {
      allowed: true,
      remaining: Number.MAX_SAFE_INTEGER,
      resetAt: now + this.#windowMs,
      violatedKey: undefined as string | undefined,
    };

    for (const item of keys) {
      const bucket = (this.#requests.get(item.key) ?? []).filter((ts) => ts >= windowStart);
      bucket.push(now);
      this.#requests.set(item.key, bucket);

      const allowed = bucket.length <= item.limit;
      const remaining = Math.max(0, item.limit - bucket.length);
      const resetAt = (bucket[0] ?? now) + this.#windowMs;
      if (!allowed) {
        return { allowed, remaining, resetAt, violatedKey: item.key };
      }
      if (remaining < mostRestrictive.remaining) {
        mostRestrictive = { allowed, remaining, resetAt, violatedKey: undefined };
      }
    }

    return mostRestrictive;
  }
}

export class RedisRateLimiter implements RateLimiter {
  readonly #client: RedisClient;
  readonly #windowSeconds: number;

  constructor(client: RedisClient, windowMs: number) {
    this.#client = client;
    this.#windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  }

  async check(keys: Array<{ key: string; limit: number }>): Promise<{
    allowed: boolean;
    remaining: number;
    resetAt: number;
    violatedKey?: string;
  }> {
    const now = Date.now();
    let mostRestrictive = {
      allowed: true,
      remaining: Number.MAX_SAFE_INTEGER,
      resetAt: now + this.#windowSeconds * 1000,
      violatedKey: undefined as string | undefined,
    };

    for (const item of keys) {
      const count = await this.#client.incr(item.key);
      if (count === 1) {
        await this.#client.expire(item.key, this.#windowSeconds);
      }
      const allowed = count <= item.limit;
      const remaining = Math.max(0, item.limit - count);
      const resetAt = now + this.#windowSeconds * 1000;
      if (!allowed) {
        return { allowed, remaining, resetAt, violatedKey: item.key };
      }
      if (remaining < mostRestrictive.remaining) {
        mostRestrictive = { allowed, remaining, resetAt, violatedKey: undefined };
      }
    }

    return mostRestrictive;
  }
}
