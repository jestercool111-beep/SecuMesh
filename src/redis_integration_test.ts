import { createHandler } from './app.ts';
import type { AppConfig } from './config.ts';
import { AuditService, type AuditSink } from './services/audit.ts';
import { RedisClient } from './store/redis_client.ts';
import { RedisSessionStore } from './store/redis_session_store.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
  }
}

class NoopAuditSink implements AuditSink {
  async write(): Promise<void> {
  }
}

function createQuietAuditService(): AuditService {
  return new AuditService([new NoopAuditSink()]);
}

function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    host: '127.0.0.1',
    port: 8080,
    upstreamBaseUrl: 'https://upstream.test',
    upstreamApiKey: undefined,
    internalApiKeys: new Set(['internal-test-key']),
    sessionStoreDriver: 'redis',
    allowedModels: new Set(),
    blockOnInjection: false,
    outputBlockTerms: [],
    outputBlockMode: 'replace',
    sessionTtlSeconds: 1800,
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 120,
    enableConsoleAudit: false,
    auditLogPath: '',
    redisUrl: 'redis://127.0.0.1:6390/0',
    redisKeyPrefix: `test:${crypto.randomUUID()}:`,
  };

  return {
    ...base,
    ...overrides,
    sessionStoreDriver: overrides.sessionStoreDriver ?? base.sessionStoreDriver,
    allowedModels: overrides.allowedModels ?? base.allowedModels,
    outputBlockTerms: overrides.outputBlockTerms ?? base.outputBlockTerms,
    outputBlockMode: overrides.outputBlockMode ?? base.outputBlockMode,
    enableConsoleAudit: overrides.enableConsoleAudit ?? base.enableConsoleAudit,
    auditLogPath: overrides.auditLogPath ?? base.auditLogPath,
    redisUrl: overrides.redisUrl ?? base.redisUrl,
    redisKeyPrefix: overrides.redisKeyPrefix ?? base.redisKeyPrefix,
  };
}

function createServeInfo(): Deno.ServeHandlerInfo<Deno.NetAddr> {
  return {
    remoteAddr: {
      transport: 'tcp',
      hostname: '127.0.0.1',
      port: 54021,
    },
    completed: Promise.resolve(),
  };
}

async function invokeGateway(
  handler: Deno.ServeHandler<Deno.NetAddr>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('authorization')) {
    headers.set('authorization', 'Bearer internal-test-key');
  }

  return await handler(
    new Request(`http://gateway.local${path}`, {
      ...init,
      headers,
    }),
    createServeInfo(),
  );
}

async function withRedisServer(run: (url: string) => Promise<void>): Promise<void> {
  const port = 6390;
  const dir = await Deno.makeTempDir({ dir: '/tmp', prefix: 'secumesh-redis-' });
  const process = new Deno.Command('redis-server', {
    args: [
      '--port',
      String(port),
      '--bind',
      '127.0.0.1',
      '--save',
      '',
      '--appendonly',
      'no',
      '--dir',
      dir,
    ],
    stdout: 'null',
    stderr: 'null',
  }).spawn();

  const client = new RedisClient(`redis://127.0.0.1:${port}/0`);

  try {
    await waitForRedis(client);
    await run(`redis://127.0.0.1:${port}/0`);
  } finally {
    try {
      await client.shutdown();
    } catch {
      // Ignore shutdown errors from a server that has already stopped.
    }

    try {
      process.kill('SIGTERM');
    } catch {
      // Ignore if the process has already terminated after SHUTDOWN.
    }

    await process.status;
    await Deno.remove(dir, { recursive: true });
  }
}

async function waitForRedis(client: RedisClient): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const pong = await client.ping();
      if (pong === 'PONG') {
        return;
      }
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Redis did not become ready.');
}

Deno.test({
  name: 'RedisSessionStore persists and reuses placeholders',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRedisServer(async (redisUrl) => {
      const sessionId = 'redis-session-1';
      const store = new RedisSessionStore(
        new RedisClient(redisUrl),
        1800,
        'test:store:',
      );

      const first = await store.maskValue(sessionId, '13800138000', 'PHONE');
      const second = await store.maskValue(sessionId, '13800138000', 'PHONE');
      const mappings = await store.getMappings(sessionId);

      assertEquals(first, '[PHONE_001]', 'Expected first placeholder to be deterministic');
      assertEquals(second, first, 'Expected repeated masking to reuse placeholder');
      assertEquals(
        mappings.get('[PHONE_001]'),
        '13800138000',
        'Expected Redis mapping to store original value',
      );

      await store.clearSession(sessionId);
    });
  },
});

Deno.test({
  name: 'Gateway can use Redis-backed session storage end-to-end',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRedisServer(async (redisUrl) => {
      let capturedRequestContent = '';
      const config = createTestConfig({
        redisUrl,
        redisKeyPrefix: `test:gateway:${crypto.randomUUID()}:`,
      });

      const fetchImpl: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const payload = await request.json();
        capturedRequestContent = payload.messages[0].content;

        return new Response(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Redis restored [PHONE_001]',
                },
              },
            ],
          }),
          {
            headers: {
              'content-type': 'application/json; charset=utf-8',
            },
          },
        );
      };

      const handler = createHandler(config, {
        fetchImpl,
        auditService: createQuietAuditService(),
      });

      const response = await invokeGateway(handler, '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-id': 'redis-gateway-session',
        },
        body: JSON.stringify({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Redis phone 13800138000' }],
        }),
      });

      const payload = await response.json();
      const content = payload.choices[0].message.content;

      assert(capturedRequestContent.includes('[PHONE_001]'), 'Expected masked request upstream');
      assert(
        content.includes('13800138000'),
        'Expected gateway to restore Redis-backed placeholder mapping',
      );
    });
  },
});
