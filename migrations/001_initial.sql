CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(50) UNIQUE NOT NULL,
  plan VARCHAR(20) DEFAULT 'starter',
  status VARCHAR(20) DEFAULT 'active',
  masking_config JSONB DEFAULT '{}'::jsonb,
  routing_config JSONB DEFAULT '{}'::jsonb,
  quota_config JSONB DEFAULT '{}'::jsonb,
  billing_info JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  dept_id UUID REFERENCES departments(id),
  email VARCHAR(200) NOT NULL,
  name VARCHAR(100),
  role VARCHAR(20) NOT NULL DEFAULT 'user',
  is_active BOOLEAN DEFAULT true,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_users_tenant_email ON users(tenant_id, email);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash VARCHAR(64) UNIQUE NOT NULL,
  key_prefix VARCHAR(8) NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID REFERENCES users(id),
  name VARCHAR(100),
  scopes TEXT[] DEFAULT ARRAY['chat'],
  is_active BOOLEAN DEFAULT true,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE upstream_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name VARCHAR(50),
  provider VARCHAR(30),
  base_url VARCHAR(300),
  api_key_enc TEXT NOT NULL,
  models TEXT[],
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 10,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID UNIQUE NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  dept_id UUID,
  user_id UUID,
  api_key_id UUID,
  upstream VARCHAR(50),
  model VARCHAR(100),
  request_body JSONB,
  response_body JSONB,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  status_code INTEGER,
  error_type VARCHAR(100),
  error_message TEXT,
  is_stream BOOLEAN DEFAULT false,
  masked_entities JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_tenant_time ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_audit_user_time ON audit_logs(user_id, created_at DESC);

CREATE TABLE usage_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  dept_id UUID,
  user_id UUID,
  api_key_id UUID,
  period_hour TIMESTAMPTZ NOT NULL,
  upstream VARCHAR(50) NOT NULL,
  model VARCHAR(100) NOT NULL,
  input_tokens BIGINT DEFAULT 0,
  output_tokens BIGINT DEFAULT 0,
  request_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX idx_usage_hour_scope
  ON usage_stats(tenant_id, COALESCE(dept_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(api_key_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 period_hour, upstream, model);
