export interface AppConfig {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  upstreamApiKey?: string;
  internalApiKeys: Set<string>;
  sessionStoreDriver: 'memory' | 'redis';
  allowedModels: Set<string>;
  blockOnInjection: boolean;
  outputBlockTerms: string[];
  outputBlockMode: 'replace' | 'block';
  sessionTtlSeconds: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  enableConsoleAudit: boolean;
  auditLogPath: string;
  redisUrl: string;
  redisKeyPrefix: string;
}

function loadDotEnv(path = '.env'): Map<string, string> {
  try {
    const content = Deno.readTextFileSync(path);
    const values = new Map<string, string>();

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const normalized = line.startsWith('export ') ? line.slice('export '.length) : line;
      const separatorIndex = normalized.indexOf('=');
      if (separatorIndex <= 0) {
        continue;
      }

      const key = normalized.slice(0, separatorIndex).trim();
      let value = normalized.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      values.set(key, value);
    }

    return values;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Map();
    }
    throw error;
  }
}

function readEnv(dotEnv: Map<string, string>, key: string): string | undefined {
  return Deno.env.get(key) ?? dotEnv.get(key);
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): AppConfig {
  const dotEnv = loadDotEnv();
  const internalApiKeys = new Set(
    (readEnv(dotEnv, 'INTERNAL_API_KEYS') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const allowedModels = new Set(
    (readEnv(dotEnv, 'ALLOWED_MODELS') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const outputBlockTerms = (readEnv(dotEnv, 'OUTPUT_BLOCK_TERMS') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    host: readEnv(dotEnv, 'HOST') ?? '0.0.0.0',
    port: parseNumber(readEnv(dotEnv, 'PORT'), 8080),
    upstreamBaseUrl: (readEnv(dotEnv, 'UPSTREAM_BASE_URL') ?? '').trim(),
    upstreamApiKey: (readEnv(dotEnv, 'UPSTREAM_API_KEY') ?? '').trim() || undefined,
    internalApiKeys,
    sessionStoreDriver: (readEnv(dotEnv, 'SESSION_STORE_DRIVER') ?? 'memory').trim() === 'redis'
      ? 'redis'
      : 'memory',
    allowedModels,
    blockOnInjection: parseBoolean(readEnv(dotEnv, 'BLOCK_ON_INJECTION'), false),
    outputBlockTerms,
    outputBlockMode: (readEnv(dotEnv, 'OUTPUT_BLOCK_MODE') ?? 'replace').trim() === 'block'
      ? 'block'
      : 'replace',
    sessionTtlSeconds: parseNumber(readEnv(dotEnv, 'SESSION_TTL_SECONDS'), 1800),
    rateLimitWindowMs: parseNumber(readEnv(dotEnv, 'RATE_LIMIT_WINDOW_MS'), 60_000),
    rateLimitMaxRequests: parseNumber(readEnv(dotEnv, 'RATE_LIMIT_MAX_REQUESTS'), 120),
    enableConsoleAudit: parseBoolean(readEnv(dotEnv, 'ENABLE_CONSOLE_AUDIT'), true),
    auditLogPath: (readEnv(dotEnv, 'AUDIT_LOG_PATH') ?? 'logs/audit.jsonl').trim(),
    redisUrl: (readEnv(dotEnv, 'REDIS_URL') ?? 'redis://127.0.0.1:6379/0').trim(),
    redisKeyPrefix: (readEnv(dotEnv, 'REDIS_KEY_PREFIX') ?? 'secumesh:session:').trim(),
  };
}
