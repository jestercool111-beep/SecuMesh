import type { AuditEvent } from '../types.ts';

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
  healthCheck?(): Promise<{ ok: boolean; details?: string }>;
}

export class ConsoleAuditSink implements AuditSink {
  async write(event: AuditEvent): Promise<void> {
    console.log(JSON.stringify({ type: 'audit', ...event }));
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    return { ok: true };
  }
}

export class FileAuditSink implements AuditSink {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async write(event: AuditEvent): Promise<void> {
    await this.#ensureParentDirectory();
    await Deno.writeTextFile(
      this.#path,
      `${JSON.stringify({ type: 'audit', ...event })}\n`,
      { append: true, create: true },
    );
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    try {
      await this.#ensureParentDirectory();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        details: error instanceof Error ? error.message : 'Unknown file audit error.',
      };
    }
  }

  async #ensureParentDirectory(): Promise<void> {
    const directory = this.#path.split('/').slice(0, -1).join('/');
    if (directory) {
      await Deno.mkdir(directory, { recursive: true });
    }
  }
}

export class KafkaAuditSink implements AuditSink {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async write(event: AuditEvent): Promise<void> {
    const directory = this.#path.split('/').slice(0, -1).join('/');
    if (directory) {
      await Deno.mkdir(directory, { recursive: true });
    }
    await Deno.writeTextFile(this.#path, `${JSON.stringify({ type: 'audit', ...event })}\n`, {
      append: true,
      create: true,
    });
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    try {
      const directory = this.#path.split('/').slice(0, -1).join('/');
      if (directory) {
        await Deno.mkdir(directory, { recursive: true });
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        details: error instanceof Error ? error.message : 'Unknown Kafka sink error.',
      };
    }
  }
}

export class AuditService {
  readonly #sinks: AuditSink[];

  constructor(sinks: AuditSink[]) {
    this.#sinks = sinks;
  }

  emit(event: AuditEvent): void {
    queueMicrotask(async () => {
      await Promise.allSettled(this.#sinks.map((sink) => sink.write(event)));
    });
  }

  async healthCheck(): Promise<
    { ok: boolean; sinks: Array<{ name: string; ok: boolean; details?: string }> }
  > {
    const results = await Promise.all(
      this.#sinks.map(async (sink) => {
        const result = await sink.healthCheck?.() ?? { ok: true };
        return {
          name: sink.constructor.name,
          ok: result.ok,
          details: result.details,
        };
      }),
    );

    return {
      ok: results.every((item) => item.ok),
      sinks: results,
    };
  }
}

export interface AuditQuery {
  limit: number;
  requestId?: string;
  sessionId?: string;
  tenantId?: string;
  userId?: string;
  deptId?: string;
  model?: string;
  status?: number;
  from?: string;
  to?: string;
}

export interface AuditQueryResult {
  items: AuditEvent[];
  count: number;
  source: string;
}

export class FileAuditRepository {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async query(params: AuditQuery): Promise<AuditQueryResult> {
    const text = await Deno.readTextFile(this.#path).catch((error) => {
      if (error instanceof Deno.errors.NotFound) {
        return '';
      }
      throw error;
    });

    const items = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent & { type?: string })
      .filter((item) => {
        if (params.requestId && item.requestId !== params.requestId) {
          return false;
        }
        if (params.sessionId && item.sessionId !== params.sessionId) {
          return false;
        }
        if (params.tenantId && item.tenantId !== params.tenantId) {
          return false;
        }
        if (params.userId && item.userId !== params.userId) {
          return false;
        }
        if (params.deptId && item.deptId !== params.deptId) {
          return false;
        }
        if (params.model && item.model !== params.model) {
          return false;
        }
        if (params.status !== undefined && item.status !== params.status) {
          return false;
        }
        if (params.from || params.to) {
          const timestamp = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
          if (!Number.isFinite(timestamp)) {
            return false;
          }
          if (params.from) {
            const from = Date.parse(params.from);
            if (Number.isFinite(from) && timestamp < from) {
              return false;
            }
          }
          if (params.to) {
            const to = Date.parse(params.to);
            if (Number.isFinite(to) && timestamp > to) {
              return false;
            }
          }
        }
        return true;
      })
      .slice(-params.limit)
      .reverse()
      .map((item) => {
        const { type: _ignored, ...event } = item;
        return event;
      });

    return {
      items,
      count: items.length,
      source: this.#path,
    };
  }

  async getByRequestId(requestId: string): Promise<AuditEvent | undefined> {
    const result = await this.query({
      limit: 10_000,
      requestId,
    });
    return result.items.find((item) => item.requestId === requestId);
  }
}
