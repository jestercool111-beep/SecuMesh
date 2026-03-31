import type { AppConfig } from '../config.ts';
import { RedisClient } from './redis_client.ts';
import { RedisSessionStore } from './redis_session_store.ts';
import { InMemorySessionStore, type SessionStore } from './session_store.ts';

export function createSessionStore(config: AppConfig): SessionStore {
  if (config.sessionStoreDriver === 'redis') {
    return new RedisSessionStore(
      new RedisClient(config.redisUrl),
      config.sessionTtlSeconds,
      config.redisKeyPrefix,
    );
  }

  return new InMemorySessionStore(config.sessionTtlSeconds);
}
