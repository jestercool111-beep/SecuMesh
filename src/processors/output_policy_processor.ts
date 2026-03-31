import type { SecurityFinding } from '../types.ts';

export interface OutputPolicyResult {
  blocked: boolean;
  findings: SecurityFinding[];
  text: string;
}

export class OutputPolicyProcessor {
  readonly #terms: string[];
  readonly #mode: 'replace' | 'block';

  constructor(terms: string[], mode: 'replace' | 'block') {
    this.#terms = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
    this.#mode = mode;
  }

  enforceText(text: string): OutputPolicyResult {
    return this.#apply(text);
  }

  createFilterStream(
    source: ReadableStream<Uint8Array>,
    onFindings?: (findings: SecurityFinding[]) => void,
  ): ReadableStream<Uint8Array> {
    const tailSize = Math.max(64, ...this.#terms.map((item) => item.length + 8));
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
            const result = this.#apply(head);
            if (result.findings.length > 0) {
              onFindings?.(result.findings);
            }
            controller.enqueue(result.text);
          },
          flush: (controller) => {
            const result = this.#apply(buffer);
            if (result.findings.length > 0) {
              onFindings?.(result.findings);
            }
            controller.enqueue(result.text);
          },
        }),
      )
      .pipeThrough(new TextEncoderStream());
  }

  #apply(text: string): OutputPolicyResult {
    if (this.#terms.length === 0) {
      return { blocked: false, findings: [], text };
    }

    const findings: SecurityFinding[] = [];
    let filtered = text;

    for (const term of this.#terms) {
      const pattern = new RegExp(escapeRegExp(term), 'gi');
      if (!pattern.test(filtered)) {
        continue;
      }

      findings.push({
        code: 'OUTPUT_BLOCKED_TERM',
        message: `Blocked sensitive output term: ${term}`,
        severity: 'high',
        action: 'block',
      });
      filtered = filtered.replace(pattern, '[CONTENT_BLOCKED]');
    }

    return {
      blocked: findings.length > 0 && this.#mode === 'block',
      findings,
      text: filtered,
    };
  }
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
