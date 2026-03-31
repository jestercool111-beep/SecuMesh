export interface SessionMapping {
  placeholderToOriginal: Map<string, string>;
  originalToPlaceholder: Map<string, string>;
  counters: Map<string, number>;
  expiresAt: number;
}

export interface SessionStore {
  maskValue(sessionId: string, original: string, category: string): Promise<string>;
  getMappings(sessionId: string): Promise<Map<string, string>>;
  healthCheck(): Promise<{ ok: boolean; driver: string; details?: string }>;
}

export class InMemorySessionStore implements SessionStore {
  readonly #ttlMs: number;
  readonly #sessions = new Map<string, SessionMapping>();

  constructor(ttlSeconds: number) {
    this.#ttlMs = ttlSeconds * 1000;
  }

  async maskValue(sessionId: string, original: string, category: string): Promise<string> {
    const session = this.#getOrCreate(sessionId);
    const existing = session.originalToPlaceholder.get(original);
    if (existing) {
      session.expiresAt = Date.now() + this.#ttlMs;
      return existing;
    }

    const placeholder = this.#nextPlaceholder(session, category);
    session.placeholderToOriginal.set(placeholder, original);
    session.originalToPlaceholder.set(original, placeholder);
    session.expiresAt = Date.now() + this.#ttlMs;
    return placeholder;
  }

  async getMappings(sessionId: string): Promise<Map<string, string>> {
    const session = this.#getSession(sessionId);
    if (!session) {
      return new Map();
    }

    return new Map(session.placeholderToOriginal);
  }

  async healthCheck(): Promise<{ ok: boolean; driver: string; details?: string }> {
    return { ok: true, driver: 'memory' };
  }

  #nextPlaceholder(session: SessionMapping, category: string): string {
    const next = (session.counters.get(category) ?? 0) + 1;
    session.counters.set(category, next);
    return `[${category}_${String(next).padStart(3, '0')}]`;
  }

  #getSession(sessionId: string): SessionMapping | undefined {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    if (session.expiresAt < Date.now()) {
      this.#sessions.delete(sessionId);
      return undefined;
    }

    return session;
  }

  #getOrCreate(sessionId: string): SessionMapping {
    const existing = this.#getSession(sessionId);
    if (existing) {
      return existing;
    }

    const created: SessionMapping = {
      placeholderToOriginal: new Map(),
      originalToPlaceholder: new Map(),
      counters: new Map(),
      expiresAt: Date.now() + this.#ttlMs,
    };
    this.#sessions.set(sessionId, created);
    return created;
  }
}
