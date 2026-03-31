import type { SecurityFinding } from '../types.ts';

const INJECTION_PATTERNS: Array<
  { pattern: RegExp; message: string; severity: SecurityFinding['severity'] }
> = [
  {
    pattern: /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
    message: 'Potential attempt to override prior instructions.',
    severity: 'high',
  },
  {
    pattern: /(reveal|show|print).{0,24}(system|developer)\s+prompt/i,
    message: 'Potential attempt to reveal hidden prompt content.',
    severity: 'high',
  },
  {
    pattern: /(bypass|disable|circumvent).{0,24}(policy|guardrail|filter|safety)/i,
    message: 'Potential attempt to bypass policy or safety controls.',
    severity: 'high',
  },
  {
    pattern: /(jailbreak|prompt injection|越权|忽略之前的指令)/i,
    message: 'Potential jailbreak or privilege escalation language detected.',
    severity: 'medium',
  },
];

export class InjectionChecker {
  inspect(text: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];

    for (const rule of INJECTION_PATTERNS) {
      if (rule.pattern.test(text)) {
        findings.push({
          code: 'PROMPT_INJECTION',
          message: rule.message,
          severity: rule.severity,
          action: rule.severity === 'high' ? 'block' : 'observe',
        });
      }
    }

    return findings;
  }
}
