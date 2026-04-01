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
  route: string;
  method: string;
  clientIp: string;
  user?: string;
  model?: string;
  status: number;
  upstreamStatus?: number;
  errorType?: string;
  durationMs: number;
  stream: boolean;
  findingsCount?: number;
  requestBytes?: number;
  responseBytes?: number;
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  findings: SecurityFinding[];
  meta?: Record<string, unknown>;
}

export interface DependencyHealth {
  name: string;
  ok: boolean;
  details?: string;
}
