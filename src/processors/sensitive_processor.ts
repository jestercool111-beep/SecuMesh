import type { SessionStore } from '../store/session_store.ts';
import type { MaskingPolicy } from '../domain.ts';
import type {
  ChatCompletionsRequest,
  ChatMessage,
  ChatMessagePart,
  SecurityFinding,
} from '../types.ts';

type SensitiveRule = {
  category: string;
  pattern: RegExp;
  message: string;
};

const SENSITIVE_RULES: SensitiveRule[] = [
  {
    category: 'PHONE',
    pattern: /(?<!\d)(1[3-9]\d{9})(?!\d)/g,
    message: 'CN mobile number masked.',
  },
  {
    category: 'IDCARD',
    pattern:
      /(?<![0-9Xx])([1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx])(?![0-9Xx])/g,
    message: 'PRC ID number masked.',
  },
  {
    category: 'BANK_CARD',
    pattern: /(?<!\d)([3-6]\d{15,18})(?!\d)/g,
    message: 'Bank card number masked.',
  },
  {
    category: 'EMAIL',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    message: 'Email address masked.',
  },
  {
    category: 'IP_ADDRESS',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    message: 'IP address masked.',
  },
  {
    category: 'URL',
    pattern: /\bhttps?:\/\/[^\s/$.?#].[^\s]*\b/gi,
    message: 'URL masked.',
  },
] as const;

export class SensitiveProcessor {
  readonly #store: SessionStore;

  constructor(store: SessionStore) {
    this.#store = store;
  }

  async sanitizeRequest(
    sessionId: string,
    input: ChatCompletionsRequest,
    policy?: MaskingPolicy,
  ): Promise<{ body: ChatCompletionsRequest; findings: SecurityFinding[] }> {
    const cloned = structuredClone(input);
    const findings: SecurityFinding[] = [];
    const rules = buildRules(policy);

    cloned.messages = await Promise.all(
      cloned.messages.map((message) => this.#maskMessage(sessionId, message, findings, rules)),
    );

    return { body: cloned, findings };
  }

  async restoreText(sessionId: string, text: string): Promise<string> {
    const mappings = await this.#store.getMappings(sessionId);
    return restoreWithMappings(text, mappings);
  }

  async createRestoreStream(
    sessionId: string,
    source: ReadableStream<Uint8Array>,
  ): Promise<ReadableStream<Uint8Array>> {
    const mappings = await this.#store.getMappings(sessionId);
    const placeholders = [...mappings.keys()].sort((a, b) => b.length - a.length);
    const tailSize = Math.max(64, ...placeholders.map((item) => item.length + 8));
    let buffer = '';

    return source
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new TransformStream<string, string>({
          transform: (chunk, controller) => {
            buffer += chunk;
            const safeLength = Math.max(0, buffer.length - tailSize);
            const head = buffer.slice(0, safeLength);
            buffer = buffer.slice(safeLength);
            controller.enqueue(restoreWithMappings(head, mappings));
          },
          flush: (controller) => {
            controller.enqueue(restoreWithMappings(buffer, mappings));
          },
        }),
      )
      .pipeThrough(new TextEncoderStream());
  }

  async #maskMessage(
    sessionId: string,
    message: ChatMessage,
    findings: SecurityFinding[],
    rules: SensitiveRule[],
  ): Promise<ChatMessage> {
    const masked = { ...message };
    if (typeof masked.content === 'string') {
      masked.content = await this.#maskText(sessionId, masked.content, findings, rules);
      return masked;
    }

    if (Array.isArray(masked.content)) {
      masked.content = await Promise.all(
        masked.content.map((part) => this.#maskPart(sessionId, part, findings, rules)),
      );
    }

    return masked;
  }

  async #maskPart(
    sessionId: string,
    part: ChatMessagePart,
    findings: SecurityFinding[],
    rules: SensitiveRule[],
  ): Promise<ChatMessagePart> {
    if (part.type !== 'text' || typeof part.text !== 'string') {
      return part;
    }

    return {
      ...part,
      text: await this.#maskText(sessionId, part.text, findings, rules),
    };
  }

  async #maskText(
    sessionId: string,
    text: string,
    findings: SecurityFinding[],
    rules: SensitiveRule[],
  ): Promise<string> {
    let maskedText = text;

    for (const rule of rules) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      const matches = [...maskedText.matchAll(pattern)];
      for (const match of matches) {
        const matched = match[0];
        const placeholder = await this.#store.maskValue(sessionId, matched, rule.category);
        maskedText = maskedText.replace(matched, placeholder);
        findings.push({
          code: `${rule.category}_MASKED`,
          message: rule.message,
          severity: 'medium',
          action: 'mask',
        });
      }
    }

    return maskedText;
  }
}

function buildRules(policy?: MaskingPolicy): SensitiveRule[] {
  let rules = [...SENSITIVE_RULES];
  if (policy?.enabled === false) {
    return [];
  }
  if (policy?.entityTypes?.length) {
    const allowed = new Set(policy.entityTypes.map((item) => item.toUpperCase()));
    rules = rules.filter((rule) => allowed.has(rule.category));
  }
  if (policy?.customKeywords?.length) {
    for (const keyword of policy.customKeywords) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rules.push({
        category: 'CUSTOM_KEYWORD',
        pattern: new RegExp(escaped, 'g'),
        message: 'Custom keyword masked.',
      });
    }
  }
  return rules;
}

function restoreWithMappings(text: string, mappings: Map<string, string>): string {
  const placeholders = [...mappings.keys()].sort((a, b) => b.length - a.length);
  let restored = text;
  for (const placeholder of placeholders) {
    const original = mappings.get(placeholder);
    if (!original) {
      continue;
    }
    restored = restored.split(placeholder).join(original);
  }
  return restored;
}
