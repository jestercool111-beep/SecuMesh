export interface AppConfig {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  upstreamApiKey?: string;
  internalApiKeys: Set<string>;
  adminApiKeys: Set<string>;
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
  kafkaBroker: string;
  kafkaAuditTopic: string;
  postgresUrl: string;
  jwtSecret: string;
  redisUrl: string;
  redisKeyPrefix: string;
}

export interface ConfigValidationResult {
  errors: string[];
  warnings: string[];
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
  const adminApiKeys = new Set(
    (readEnv(dotEnv, 'ADMIN_API_KEYS') ?? '')
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
    adminApiKeys,
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
    kafkaBroker: (readEnv(dotEnv, 'KAFKA_BROKER') ?? 'kafka:9092').trim(),
    kafkaAuditTopic: (readEnv(dotEnv, 'KAFKA_AUDIT_TOPIC') ?? 'audit-log-raw').trim(),
    postgresUrl: (readEnv(dotEnv, 'POSTGRES_URL') ??
      'postgres://secumesh:secumesh@postgres:5432/secumesh').trim(),
    jwtSecret: (readEnv(dotEnv, 'JWT_SECRET') ?? 'secumesh-dev-secret').trim(),
    redisUrl: (readEnv(dotEnv, 'REDIS_URL') ?? 'redis://127.0.0.1:6379/0').trim(),
    redisKeyPrefix: (readEnv(dotEnv, 'REDIS_KEY_PREFIX') ?? 'secumesh:session:').trim(),
  };
}

export function validateConfig(config: AppConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.host.trim()) {
    errors.push('HOST must not be empty.');
  }

  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    errors.push(`PORT must be a valid TCP port, received ${config.port}.`);
  }

  if (config.internalApiKeys.size === 0) {
    warnings.push(
      'INTERNAL_API_KEYS is empty. Chat endpoints will accept requests without gateway authentication.',
    );
  }

  if (getAdminApiKeys(config).size === 0) {
    warnings.push(
      'ADMIN_API_KEYS is empty. Admin routes will not require dedicated admin credentials.',
    );
  }

  if (config.sessionStoreDriver === 'redis') {
    if (!config.redisUrl.trim()) {
      errors.push('REDIS_URL is required when SESSION_STORE_DRIVER=redis.');
    } else if (!config.redisUrl.startsWith('redis://')) {
      errors.push(`REDIS_URL must use redis:// scheme, received ${config.redisUrl}.`);
    }
  } else if (config.sessionStoreDriver === 'memory') {
    warnings.push(
      'SESSION_STORE_DRIVER=memory is suitable for local development only. Use redis for shared session state in production.',
    );
  }

  if (!config.upstreamBaseUrl.trim()) {
    warnings.push(
      'UPSTREAM_BASE_URL is not configured. /ready will stay degraded and chat proxying will fail until it is set.',
    );
  } else {
    try {
      const url = new URL(config.upstreamBaseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        errors.push(
          `UPSTREAM_BASE_URL must start with http:// or https://, received ${config.upstreamBaseUrl}.`,
        );
      }
      if (
        (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
        config.sessionStoreDriver === 'redis'
      ) {
        warnings.push(
          'UPSTREAM_BASE_URL points to localhost/127.0.0.1. If the gateway runs in Docker, this will not reach a host-side One API unless network routing is configured explicitly.',
        );
      }
    } catch {
      errors.push(`UPSTREAM_BASE_URL is not a valid URL: ${config.upstreamBaseUrl}.`);
    }
  }

  if (!['replace', 'block'].includes(config.outputBlockMode)) {
    errors.push(`OUTPUT_BLOCK_MODE must be replace or block, received ${config.outputBlockMode}.`);
  }

  if (!Number.isFinite(config.rateLimitWindowMs) || config.rateLimitWindowMs <= 0) {
    errors.push(
      `RATE_LIMIT_WINDOW_MS must be a positive number, received ${config.rateLimitWindowMs}.`,
    );
  }

  if (!Number.isFinite(config.rateLimitMaxRequests) || config.rateLimitMaxRequests <= 0) {
    errors.push(
      `RATE_LIMIT_MAX_REQUESTS must be a positive number, received ${config.rateLimitMaxRequests}.`,
    );
  }

  if (!Number.isFinite(config.sessionTtlSeconds) || config.sessionTtlSeconds <= 0) {
    errors.push(
      `SESSION_TTL_SECONDS must be a positive number, received ${config.sessionTtlSeconds}.`,
    );
  }

  if (!config.auditLogPath.trim()) {
    warnings.push(
      'AUDIT_LOG_PATH is empty. File-based audit persistence is disabled unless another audit sink is configured.',
    );
  }

  if (!config.postgresUrl.trim()) {
    warnings.push(
      'POSTGRES_URL is empty. PostgreSQL-backed metadata/audit persistence is disabled.',
    );
  }

  if (!config.kafkaBroker.trim()) {
    warnings.push('KAFKA_BROKER is empty. Kafka audit fan-out is disabled.');
  }

  if (!config.jwtSecret.trim()) {
    warnings.push('JWT_SECRET is empty. JWT-based console auth cannot be enabled safely.');
  }

  return { errors, warnings };
}

function getAdminApiKeys(config: AppConfig): Set<string> {
  return config.adminApiKeys.size > 0 ? config.adminApiKeys : config.internalApiKeys;
}
