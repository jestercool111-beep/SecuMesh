export type Role = 'tenant_admin' | 'dept_admin' | 'user' | 'readonly';

export interface MaskingPolicy {
  enabled: boolean;
  sensitivity: 'low' | 'medium' | 'high';
  entityTypes: string[];
  customKeywords: string[];
}

export interface RoutingPolicy {
  strategy: 'tenant_default' | 'model_based' | 'domestic_first';
  preferredUpstreamId?: string;
}

export interface QuotaConfig {
  tenantPerMinute: number;
  deptPerMinute: number;
  userPerMinute: number;
  apiKeyPerMinute: number;
}

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  plan: string;
  status: 'active' | 'disabled';
  maskingPolicy: MaskingPolicy;
  routingPolicy: RoutingPolicy;
  quotaConfig: QuotaConfig;
  billingInfo?: Record<string, unknown>;
  createdAt: string;
}

export interface DepartmentRecord {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface UserRecord {
  id: string;
  tenantId: string;
  deptId?: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

export interface ApiKeyRecord {
  id: string;
  keyHash: string;
  keyPrefix: string;
  tenantId: string;
  userId?: string;
  name: string;
  scopes: string[];
  isActive: boolean;
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt: string;
}

export interface UpstreamProviderRecord {
  id: string;
  tenantId: string;
  name: string;
  provider: 'one_api' | 'openai' | 'anthropic' | 'google' | 'deepseek';
  baseUrl: string;
  apiKeyRef: string;
  models: string[];
  isActive: boolean;
  priority: number;
  createdAt: string;
}

export interface UsageStatRecord {
  id: string;
  tenantId: string;
  deptId?: string;
  userId?: string;
  apiKeyId?: string;
  periodHour: string;
  upstream: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  errorCount: number;
}

export interface AuthPrincipal {
  tenant: TenantRecord;
  user?: UserRecord;
  apiKey?: ApiKeyRecord;
  roles: Role[];
  scopes: string[];
}
