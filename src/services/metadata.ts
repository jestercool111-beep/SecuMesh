import type {
  ApiKeyRecord,
  AuthPrincipal,
  DepartmentRecord,
  TenantRecord,
  UpstreamProviderRecord,
  UsageStatRecord,
  UserRecord,
} from '../domain.ts';
import type { AppConfig } from '../config.ts';

export interface MetadataStore {
  authenticateApiKey(rawKey: string, tenantSlug?: string): Promise<AuthPrincipal | undefined>;
  getTenantById(tenantId: string): Promise<TenantRecord | undefined>;
  getTenantBySlug(slug: string): Promise<TenantRecord | undefined>;
  updateTenant(
    tenantId: string,
    patch: Partial<Pick<TenantRecord, 'name' | 'maskingPolicy' | 'routingPolicy' | 'quotaConfig'>>,
  ): Promise<TenantRecord | undefined>;
  listUsers(tenantId: string): Promise<UserRecord[]>;
  createUser(
    tenantId: string,
    input: Pick<UserRecord, 'email' | 'name' | 'role'> & { deptId?: string },
  ): Promise<UserRecord>;
  deactivateUser(tenantId: string, userId: string): Promise<boolean>;
  listApiKeys(tenantId: string, userId?: string): Promise<ApiKeyRecord[]>;
  createApiKey(
    tenantId: string,
    input: { userId?: string; name: string; scopes?: string[]; expiresAt?: string },
  ): Promise<{ record: ApiKeyRecord; rawKey: string }>;
  revokeApiKey(tenantId: string, apiKeyId: string): Promise<boolean>;
  listUpstreams(tenantId: string): Promise<UpstreamProviderRecord[]>;
  createUpstream(
    tenantId: string,
    input: Omit<UpstreamProviderRecord, 'id' | 'tenantId' | 'createdAt'>,
  ): Promise<UpstreamProviderRecord>;
  updateUpstream(
    tenantId: string,
    upstreamId: string,
    patch: Partial<Omit<UpstreamProviderRecord, 'id' | 'tenantId' | 'createdAt'>>,
  ): Promise<UpstreamProviderRecord | undefined>;
  deleteUpstream(tenantId: string, upstreamId: string): Promise<boolean>;
  listModelsForTenant(tenantId: string, allowlist: Set<string>): Promise<string[]>;
  getUsageSummary(tenantId: string, userId?: string): Promise<UsageStatRecord[]>;
  recordUsage(entry: UsageStatRecord): Promise<void>;
}

export class InMemoryMetadataStore implements MetadataStore {
  readonly #tenants = new Map<string, TenantRecord>();
  readonly #departments = new Map<string, DepartmentRecord>();
  readonly #users = new Map<string, UserRecord>();
  readonly #apiKeys = new Map<string, ApiKeyRecord>();
  readonly #apiKeyRawIndex = new Map<string, string>();
  readonly #upstreams = new Map<string, UpstreamProviderRecord>();
  readonly #usageStats = new Map<string, UsageStatRecord>();

  static async create(config: AppConfig): Promise<InMemoryMetadataStore> {
    const store = new InMemoryMetadataStore();
    await store.#seedDefaults(config);
    return store;
  }

  async authenticateApiKey(
    rawKey: string,
    tenantSlug?: string,
  ): Promise<AuthPrincipal | undefined> {
    const keyHash = await sha256Hex(rawKey);
    const apiKey = [...this.#apiKeys.values()].find((item) =>
      item.keyHash === keyHash &&
      item.isActive &&
      (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
    );
    if (!apiKey) {
      return undefined;
    }

    const tenant = this.#tenants.get(apiKey.tenantId);
    if (!tenant || tenant.status !== 'active') {
      return undefined;
    }
    if (tenantSlug && tenant.slug !== tenantSlug) {
      return undefined;
    }

    const user = apiKey.userId ? this.#users.get(apiKey.userId) : undefined;
    if (user && !user.isActive) {
      return undefined;
    }

    const principal: AuthPrincipal = {
      tenant,
      user,
      apiKey,
      roles: user ? [user.role] : ['tenant_admin'],
      scopes: apiKey.scopes,
    };

    apiKey.lastUsedAt = new Date().toISOString();
    return principal;
  }

  async getTenantById(tenantId: string): Promise<TenantRecord | undefined> {
    return this.#tenants.get(tenantId);
  }

  async getTenantBySlug(slug: string): Promise<TenantRecord | undefined> {
    return [...this.#tenants.values()].find((item) => item.slug === slug);
  }

  async updateTenant(
    tenantId: string,
    patch: Partial<Pick<TenantRecord, 'name' | 'maskingPolicy' | 'routingPolicy' | 'quotaConfig'>>,
  ): Promise<TenantRecord | undefined> {
    const tenant = this.#tenants.get(tenantId);
    if (!tenant) {
      return undefined;
    }
    Object.assign(tenant, patch);
    return tenant;
  }

  async listUsers(tenantId: string): Promise<UserRecord[]> {
    return [...this.#users.values()].filter((item) => item.tenantId === tenantId);
  }

  async createUser(
    tenantId: string,
    input: Pick<UserRecord, 'email' | 'name' | 'role'> & { deptId?: string },
  ): Promise<UserRecord> {
    const user: UserRecord = {
      id: crypto.randomUUID(),
      tenantId,
      deptId: input.deptId,
      email: input.email,
      name: input.name,
      role: input.role,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    this.#users.set(user.id, user);
    return user;
  }

  async deactivateUser(tenantId: string, userId: string): Promise<boolean> {
    const user = this.#users.get(userId);
    if (!user || user.tenantId !== tenantId) {
      return false;
    }
    user.isActive = false;
    return true;
  }

  async listApiKeys(tenantId: string, userId?: string): Promise<ApiKeyRecord[]> {
    return [...this.#apiKeys.values()].filter((item) =>
      item.tenantId === tenantId && (!userId || item.userId === userId)
    );
  }

  async createApiKey(
    tenantId: string,
    input: { userId?: string; name: string; scopes?: string[]; expiresAt?: string },
  ): Promise<{ record: ApiKeyRecord; rawKey: string }> {
    const rawKey = createRawApiKey();
    const record: ApiKeyRecord = {
      id: crypto.randomUUID(),
      keyHash: await sha256Hex(rawKey),
      keyPrefix: rawKey.slice(0, 8),
      tenantId,
      userId: input.userId,
      name: input.name,
      scopes: input.scopes?.length ? input.scopes : ['chat'],
      isActive: true,
      expiresAt: input.expiresAt,
      createdAt: new Date().toISOString(),
    };
    this.#apiKeys.set(record.id, record);
    this.#apiKeyRawIndex.set(record.id, rawKey);
    return { record, rawKey };
  }

  async revokeApiKey(tenantId: string, apiKeyId: string): Promise<boolean> {
    const record = this.#apiKeys.get(apiKeyId);
    if (!record || record.tenantId !== tenantId) {
      return false;
    }
    record.isActive = false;
    return true;
  }

  async listUpstreams(tenantId: string): Promise<UpstreamProviderRecord[]> {
    return [...this.#upstreams.values()]
      .filter((item) => item.tenantId === tenantId)
      .sort((a, b) => a.priority - b.priority);
  }

  async createUpstream(
    tenantId: string,
    input: Omit<UpstreamProviderRecord, 'id' | 'tenantId' | 'createdAt'>,
  ): Promise<UpstreamProviderRecord> {
    const record: UpstreamProviderRecord = {
      id: crypto.randomUUID(),
      tenantId,
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.#upstreams.set(record.id, record);
    return record;
  }

  async updateUpstream(
    tenantId: string,
    upstreamId: string,
    patch: Partial<Omit<UpstreamProviderRecord, 'id' | 'tenantId' | 'createdAt'>>,
  ): Promise<UpstreamProviderRecord | undefined> {
    const record = this.#upstreams.get(upstreamId);
    if (!record || record.tenantId !== tenantId) {
      return undefined;
    }
    Object.assign(record, patch);
    return record;
  }

  async deleteUpstream(tenantId: string, upstreamId: string): Promise<boolean> {
    const record = this.#upstreams.get(upstreamId);
    if (!record || record.tenantId !== tenantId) {
      return false;
    }
    this.#upstreams.delete(upstreamId);
    return true;
  }

  async listModelsForTenant(tenantId: string, allowlist: Set<string>): Promise<string[]> {
    const upstreamModels = (await this.listUpstreams(tenantId))
      .filter((item) => item.isActive)
      .flatMap((item) => item.models);
    const models = dedupe(upstreamModels);
    if (allowlist.size === 0) {
      return models;
    }
    return models.filter((item) => allowlist.has(item));
  }

  async getUsageSummary(tenantId: string, userId?: string): Promise<UsageStatRecord[]> {
    return [...this.#usageStats.values()].filter((item) =>
      item.tenantId === tenantId && (!userId || item.userId === userId)
    );
  }

  async recordUsage(entry: UsageStatRecord): Promise<void> {
    const key = [
      entry.tenantId,
      entry.deptId ?? '',
      entry.userId ?? '',
      entry.apiKeyId ?? '',
      entry.periodHour,
      entry.upstream,
      entry.model,
    ].join(':');
    const existing = this.#usageStats.get(key);
    if (existing) {
      existing.inputTokens += entry.inputTokens;
      existing.outputTokens += entry.outputTokens;
      existing.requestCount += entry.requestCount;
      existing.errorCount += entry.errorCount;
      return;
    }
    this.#usageStats.set(key, { ...entry, id: key });
  }

  async #seedDefaults(config: AppConfig): Promise<void> {
    const createdAt = new Date().toISOString();
    const tenant: TenantRecord = {
      id: 'tenant-demo',
      slug: 'demo',
      name: 'Demo Tenant',
      plan: 'starter',
      status: 'active',
      maskingPolicy: {
        enabled: true,
        sensitivity: 'medium',
        entityTypes: ['PHONE', 'IDCARD', 'BANK_CARD', 'EMAIL', 'IP_ADDRESS', 'URL'],
        customKeywords: [],
      },
      routingPolicy: {
        strategy: 'tenant_default',
      },
      quotaConfig: {
        tenantPerMinute: 10_000,
        deptPerMinute: 2_000,
        userPerMinute: 200,
        apiKeyPerMinute: 100,
      },
      createdAt,
    };
    this.#tenants.set(tenant.id, tenant);

    const department: DepartmentRecord = {
      id: 'dept-demo',
      tenantId: tenant.id,
      name: 'General',
      slug: 'general',
      createdAt,
    };
    this.#departments.set(department.id, department);

    const admin: UserRecord = {
      id: 'user-admin',
      tenantId: tenant.id,
      deptId: department.id,
      email: 'admin@secumesh.local',
      name: 'Tenant Admin',
      role: 'tenant_admin',
      isActive: true,
      createdAt,
    };
    this.#users.set(admin.id, admin);

    const serviceApiKey = config.internalApiKeys.values().next().value as string | undefined;
    if (serviceApiKey) {
      const record: ApiKeyRecord = {
        id: 'key-demo-service',
        keyHash: await sha256Hex(serviceApiKey),
        keyPrefix: serviceApiKey.slice(0, 8),
        tenantId: tenant.id,
        userId: admin.id,
        name: 'Demo Service Key',
        scopes: ['chat', 'embeddings', 'admin'],
        isActive: true,
        createdAt,
      };
      this.#apiKeys.set(record.id, record);
    }

    const upstream: UpstreamProviderRecord = {
      id: 'upstream-one-api',
      tenantId: tenant.id,
      name: 'one-api-primary',
      provider: 'one_api',
      baseUrl: config.upstreamBaseUrl || 'http://one-api:3000',
      apiKeyRef: 'env:UPSTREAM_API_KEY',
      models: config.allowedModels.size > 0
        ? [...config.allowedModels]
        : ['openai/gpt-3.5-turbo', 'openai/gpt-4o-mini', 'qwen/qwen-vl-plus'],
      isActive: true,
      priority: 10,
      createdAt,
    };
    this.#upstreams.set(upstream.id, upstream);
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

function createRawApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const body = [...bytes].map((item) => item.toString(16).padStart(2, '0')).join('');
  return `sk-${body}`;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
