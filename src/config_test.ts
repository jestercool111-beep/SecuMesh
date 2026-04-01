import { type AppConfig, validateConfig } from './config.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 9080,
    upstreamBaseUrl: 'http://localhost:3000',
    upstreamApiKey: undefined,
    internalApiKeys: new Set(['internal-demo-key']),
    adminApiKeys: new Set(['admin-demo-key']),
    sessionStoreDriver: 'memory',
    allowedModels: new Set(),
    blockOnInjection: false,
    outputBlockTerms: [],
    outputBlockMode: 'replace',
    sessionTtlSeconds: 1800,
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 120,
    enableConsoleAudit: false,
    auditLogPath: 'logs/audit.jsonl',
    redisUrl: 'redis://127.0.0.1:6379/0',
    redisKeyPrefix: 'secumesh:test:',
    ...overrides,
  };
}

Deno.test('validateConfig rejects invalid required values', () => {
  const result = validateConfig(
    createConfig({
      host: '',
      port: 0,
      upstreamBaseUrl: 'not-a-url',
      rateLimitWindowMs: 0,
      rateLimitMaxRequests: 0,
      sessionTtlSeconds: 0,
    }),
  );

  assert(result.errors.length >= 6, 'Expected multiple configuration errors');
  assert(result.errors.some((item) => item.includes('HOST')), 'Expected host validation error');
  assert(result.errors.some((item) => item.includes('PORT')), 'Expected port validation error');
  assert(
    result.errors.some((item) => item.includes('UPSTREAM_BASE_URL')),
    'Expected upstream URL validation error',
  );
});

Deno.test('validateConfig warns when running with local-dev style settings', () => {
  const result = validateConfig(
    createConfig({
      upstreamBaseUrl: '',
      internalApiKeys: new Set(),
      adminApiKeys: new Set(),
      sessionStoreDriver: 'memory',
      auditLogPath: '',
    }),
  );

  assert(result.errors.length === 0, 'Expected no hard validation errors for dev-mode config');
  assert(
    result.warnings.some((item) => item.includes('INTERNAL_API_KEYS')),
    'Expected warning for missing internal keys',
  );
  assert(
    result.warnings.some((item) => item.includes('ADMIN_API_KEYS')),
    'Expected warning for missing admin keys',
  );
  assert(
    result.warnings.some((item) => item.includes('UPSTREAM_BASE_URL')),
    'Expected warning for missing upstream',
  );
  assert(
    result.warnings.some((item) => item.includes('SESSION_STORE_DRIVER=memory')),
    'Expected warning for memory session store',
  );
});

Deno.test('validateConfig requires redis URL when redis driver is enabled', () => {
  const result = validateConfig(
    createConfig({
      sessionStoreDriver: 'redis',
      redisUrl: '',
    }),
  );

  assert(
    result.errors.some((item) => item.includes('REDIS_URL')),
    'Expected REDIS_URL validation error for redis session driver',
  );
});
