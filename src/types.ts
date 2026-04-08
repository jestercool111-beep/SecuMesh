export interface ChatMessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: string;
  content: string | ChatMessagePart[] | null;
  name?: string;
  [key: string]: unknown;
}

export interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  user?: string;
  [key: string]: unknown;
}

export interface SecurityFinding {
  code: string;
  message: string;
  severity: 'low' | 'medium' | 'high';
  action: 'observe' | 'mask' | 'block';
}

export interface AuditEvent {
  timestamp: string;
  requestId: string;
  sessionId: string;
  tenantId?: string;
  deptId?: string;
  userId?: string;
  apiKeyId?: string;
  route: string;
  method: string;
  clientIp: string;
  user?: string;
  upstream?: string;
  model?: string;
  status: number;
  upstreamStatus?: number;
  errorType?: string;
  errorMessage?: string;
  durationMs: number;
  stream: boolean;
  findingsCount?: number;
  requestBytes?: number;
  responseBytes?: number;
  requestBody?: unknown;
  responseBody?: unknown;
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  inputTokens?: number;
  outputTokens?: number;
  maskedEntities?: Record<string, number>;
  findings: SecurityFinding[];
  meta?: Record<string, unknown>;
}

export interface DependencyHealth {
  name: string;
  ok: boolean;
  details?: string;
}
