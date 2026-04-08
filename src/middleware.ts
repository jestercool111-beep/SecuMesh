import type { AppConfig } from './config.ts';
import type { AuthPrincipal } from './domain.ts';
import type { InjectionChecker } from './processors/injection_checker.ts';
import type { OutputPolicyProcessor } from './processors/output_policy_processor.ts';
import type { SensitiveProcessor } from './processors/sensitive_processor.ts';
import type { AuditService } from './services/audit.ts';
import type { MetadataStore } from './services/metadata.ts';
import type { RateLimiter } from './services/rate_limiter.ts';
import type { SessionStore } from './store/session_store.ts';
import type { ChatCompletionsRequest, SecurityFinding } from './types.ts';

export interface GatewayState {
  requestBody?: ChatCompletionsRequest;
  maskedRequestBody?: ChatCompletionsRequest;
  principal?: AuthPrincipal;
  findings: SecurityFinding[];
  auditMeta: Record<string, unknown>;
}

export interface GatewayContext {
  request: Request;
  config: AppConfig;
  auditService: AuditService;
  sensitiveProcessor: SensitiveProcessor;
  injectionChecker: InjectionChecker;
  outputPolicyProcessor: OutputPolicyProcessor;
  rateLimiter: RateLimiter;
  metadataStore: MetadataStore;
  sessionStore: SessionStore;
  requestId: string;
  sessionId: string;
  clientIp: string;
  startedAt: number;
  state: GatewayState;
}

export type Middleware = (
  context: GatewayContext,
  next: () => Promise<Response>,
) => Promise<Response>;

export function compose(middlewares: Middleware[]): Middleware {
  return async (context, next) => {
    let index = -1;

    async function dispatch(cursor: number): Promise<Response> {
      if (cursor <= index) {
        throw new Error('next() called multiple times');
      }
      index = cursor;
      const middleware = middlewares[cursor] ?? next;
      return await middleware(context, () => dispatch(cursor + 1));
    }

    return await dispatch(0);
  };
}
