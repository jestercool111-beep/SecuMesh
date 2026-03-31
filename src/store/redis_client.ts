interface RedisConnectionOptions {
  hostname: string;
  port: number;
  password?: string;
  username?: string;
  db: number;
}

type RedisValue = string | number | null | RedisValue[];

class RespReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  async read(): Promise<RedisValue> {
    const prefix = String.fromCharCode(await this.#readByte());
    switch (prefix) {
      case '+':
        return await this.#readLine();
      case '-':
        throw new Error(await this.#readLine());
      case ':':
        return Number(await this.#readLine());
      case '$':
        return await this.#readBulkString();
      case '*':
        return await this.#readArray();
      default:
        throw new Error(`Unsupported RESP prefix: ${prefix}`);
    }
  }

  async #readBulkString(): Promise<string | null> {
    const length = Number(await this.#readLine());
    if (length === -1) {
      return null;
    }

    const payload = await this.#readExact(length);
    await this.#readExact(2);
    return new TextDecoder().decode(payload);
  }

  async #readArray(): Promise<RedisValue[]> {
    const length = Number(await this.#readLine());
    if (length < 0) {
      return [];
    }

    const items: RedisValue[] = [];
    for (let index = 0; index < length; index += 1) {
      items.push(await this.read());
    }
    return items;
  }

  async #readLine(): Promise<string> {
    const chunks: number[] = [];
    while (true) {
      const byte = await this.#readByte();
      if (byte === 13) {
        const next = await this.#readByte();
        if (next !== 10) {
          throw new Error('Malformed RESP line ending.');
        }
        return new TextDecoder().decode(new Uint8Array(chunks));
      }
      chunks.push(byte);
    }
  }

  async #readByte(): Promise<number> {
    const chunk = await this.#readExact(1);
    return chunk[0];
  }

  async #readExact(length: number): Promise<Uint8Array> {
    while (this.#buffer.length < length) {
      const { done, value } = await this.#reader.read();
      if (done || !value) {
        throw new Error('Unexpected EOF while reading RESP payload.');
      }

      this.#buffer = concatBytes(this.#buffer, value);
    }

    const chunk = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.slice(length);
    return chunk;
  }
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}

function encodeCommand(parts: string[]): Uint8Array {
  const lines = [`*${parts.length}\r\n`];
  for (const part of parts) {
    const encoded = new TextEncoder().encode(part);
    lines.push(`$${encoded.length}\r\n`);
    lines.push(part);
    lines.push('\r\n');
  }
  return new TextEncoder().encode(lines.join(''));
}

function parseRedisUrl(url: string): RedisConnectionOptions {
  const parsed = new URL(url);
  if (parsed.protocol !== 'redis:') {
    throw new Error(`Unsupported Redis URL protocol: ${parsed.protocol}`);
  }

  const db = parsed.pathname && parsed.pathname !== '/' ? Number(parsed.pathname.slice(1)) : 0;

  return {
    hostname: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: Number.isFinite(db) ? db : 0,
  };
}

export class RedisClient {
  readonly #options: RedisConnectionOptions;

  constructor(url: string) {
    this.#options = parseRedisUrl(url);
  }

  async ping(): Promise<string> {
    return String(await this.#command(['PING']));
  }

  async hget(key: string, field: string): Promise<string | undefined> {
    const result = await this.#command(['HGET', key, field]);
    return result === null ? undefined : String(result);
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    return Number(await this.#command(['HSET', key, field, value]));
  }

  async hsetnx(key: string, field: string, value: string): Promise<boolean> {
    return Number(await this.#command(['HSETNX', key, field, value])) === 1;
  }

  async hgetall(key: string): Promise<Map<string, string>> {
    const result = await this.#command(['HGETALL', key]);
    const entries = Array.isArray(result) ? result : [];
    const mapping = new Map<string, string>();
    for (let index = 0; index < entries.length; index += 2) {
      const field = entries[index];
      const value = entries[index + 1];
      if (typeof field === 'string' && typeof value === 'string') {
        mapping.set(field, value);
      }
    }
    return mapping;
  }

  async incr(key: string): Promise<number> {
    return Number(await this.#command(['INCR', key]));
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    return Number(await this.#command(['EXPIRE', key, String(ttlSeconds)]));
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }

    return Number(await this.#command(['DEL', ...keys]));
  }

  async shutdown(): Promise<void> {
    try {
      await this.#command(['SHUTDOWN', 'NOSAVE']);
    } catch {
      // Redis closes the connection during shutdown, which is expected.
    }
  }

  async #command(parts: string[]): Promise<RedisValue> {
    const conn = await Deno.connect({
      hostname: this.#options.hostname,
      port: this.#options.port,
      transport: 'tcp',
    });

    try {
      const writer = conn.writable.getWriter();
      const reader = new RespReader(conn.readable.getReader());

      if (this.#options.password) {
        const authParts = this.#options.username
          ? ['AUTH', this.#options.username, this.#options.password]
          : ['AUTH', this.#options.password];
        await writer.write(encodeCommand(authParts));
        await reader.read();
      }

      if (this.#options.db > 0) {
        await writer.write(encodeCommand(['SELECT', String(this.#options.db)]));
        await reader.read();
      }

      await writer.write(encodeCommand(parts));
      return await reader.read();
    } finally {
      conn.close();
    }
  }
}
