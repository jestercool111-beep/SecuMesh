import type { SessionStore } from './session_store.ts';
import { RedisClient } from './redis_client.ts';

export class RedisSessionStore implements SessionStore {
  readonly #client: RedisClient;
  readonly #ttlSeconds: number;
  readonly #prefix: string;

  constructor(client: RedisClient, ttlSeconds: number, prefix = 'secumesh:session:') {
    this.#client = client;
    this.#ttlSeconds = ttlSeconds;
    this.#prefix = prefix;
  }

  async maskValue(sessionId: string, original: string, category: string): Promise<string> {
    const keys = this.#keys(sessionId, category);
    const existing = await this.#client.hget(keys.originalToPlaceholder, original);
    if (existing) {
      await this.#touch(keys);
      return existing;
    }

    const counter = await this.#client.incr(keys.counter);
    const placeholder = `[${category}_${String(counter).padStart(3, '0')}]`;
    const inserted = await this.#client.hsetnx(keys.originalToPlaceholder, original, placeholder);

    if (inserted) {
      await this.#client.hset(keys.placeholderToOriginal, placeholder, original);
      await this.#touch(keys);
      return placeholder;
    }

    const concurrent = await this.#client.hget(keys.originalToPlaceholder, original);
    if (!concurrent) {
      throw new Error('Redis session store lost placeholder mapping during concurrent insert.');
    }

    await this.#touch(keys);
    return concurrent;
  }

  async getMappings(sessionId: string): Promise<Map<string, string>> {
    const keys = this.#keys(sessionId);
    return await this.#client.hgetall(keys.placeholderToOriginal);
  }

  async healthCheck(): Promise<{ ok: boolean; driver: string; details?: string }> {
    try {
      const pong = await this.#client.ping();
      return {
        ok: pong === 'PONG',
        driver: 'redis',
        details: pong === 'PONG' ? undefined : `Unexpected Redis ping response: ${pong}`,
      };
    } catch (error) {
      return {
        ok: false,
        driver: 'redis',
        details: error instanceof Error ? error.message : 'Unknown Redis error.',
      };
    }
  }

  async clearSession(sessionId: string): Promise<void> {
    const keys = this.#keys(sessionId);
    await this.#client.del(keys.placeholderToOriginal, keys.originalToPlaceholder, keys.counter);
  }

  #keys(sessionId: string, category = 'default'): {
    placeholderToOriginal: string;
    originalToPlaceholder: string;
    counter: string;
  } {
    const base = `${this.#prefix}${sessionId}`;
    return {
      placeholderToOriginal: `${base}:p2o`,
      originalToPlaceholder: `${base}:o2p`,
      counter: `${base}:counter:${category}`,
    };
  }

  async #touch(
    keys: { placeholderToOriginal: string; originalToPlaceholder: string; counter: string },
  ): Promise<void> {
    await Promise.all([
      this.#client.expire(keys.placeholderToOriginal, this.#ttlSeconds),
      this.#client.expire(keys.originalToPlaceholder, this.#ttlSeconds),
      this.#client.expire(keys.counter, this.#ttlSeconds),
    ]);
  }
}
