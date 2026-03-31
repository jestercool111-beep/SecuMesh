import { FileAuditRepository, FileAuditSink } from './audit.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test('FileAuditSink persists audit events as jsonl', async () => {
  const directory = await Deno.makeTempDir({ dir: '/tmp', prefix: 'secumesh-audit-' });
  const path = `${directory}/audit.jsonl`;
  const sink = new FileAuditSink(path);

  await sink.write({
    timestamp: '2026-03-31T09:00:00.000Z',
    requestId: 'req-1',
    sessionId: 'session-1',
    route: '/v1/chat/completions',
    method: 'POST',
    clientIp: '127.0.0.1',
    status: 200,
    durationMs: 12,
    stream: false,
    findings: [],
  });

  const content = await Deno.readTextFile(path);
  assert(content.includes('"requestId":"req-1"'), 'Expected audit log to contain request id');
  assert(content.endsWith('\n'), 'Expected JSONL log to end with a newline');
});

Deno.test('FileAuditRepository queries most recent matching events', async () => {
  const directory = await Deno.makeTempDir({ dir: '/tmp', prefix: 'secumesh-audit-query-' });
  const path = `${directory}/audit.jsonl`;
  const sink = new FileAuditSink(path);
  const repository = new FileAuditRepository(path);

  await sink.write({
    timestamp: '2026-03-31T10:00:00.000Z',
    requestId: 'req-1',
    sessionId: 'session-a',
    route: '/v1/chat/completions',
    method: 'POST',
    clientIp: '127.0.0.1',
    model: 'openai/gpt-3.5-turbo',
    status: 200,
    durationMs: 11,
    stream: false,
    findings: [],
  });
  await sink.write({
    timestamp: '2026-03-31T10:05:00.000Z',
    requestId: 'req-2',
    sessionId: 'session-b',
    route: '/v1/chat/completions',
    method: 'POST',
    clientIp: '127.0.0.1',
    model: 'qwen/qwen-vl-plus',
    status: 451,
    durationMs: 14,
    stream: false,
    findings: [],
  });

  const result = await repository.query({
    limit: 10,
    status: 451,
  });

  assert(result.count === 1, 'Expected one matching audit event');
  assert(result.items[0].requestId === 'req-2', 'Expected repository to return matching request');
});

Deno.test('FileAuditRepository filters by time range and request id', async () => {
  const directory = await Deno.makeTempDir({ dir: '/tmp', prefix: 'secumesh-audit-time-' });
  const path = `${directory}/audit.jsonl`;
  const sink = new FileAuditSink(path);
  const repository = new FileAuditRepository(path);

  await sink.write({
    timestamp: '2026-03-31T10:00:00.000Z',
    requestId: 'req-old',
    sessionId: 'session-old',
    route: '/v1/chat/completions',
    method: 'POST',
    clientIp: '127.0.0.1',
    status: 200,
    durationMs: 10,
    stream: false,
    findings: [],
  });
  await sink.write({
    timestamp: '2026-03-31T12:00:00.000Z',
    requestId: 'req-new',
    sessionId: 'session-new',
    route: '/v1/chat/completions',
    method: 'POST',
    clientIp: '127.0.0.1',
    status: 200,
    durationMs: 10,
    stream: false,
    findings: [],
  });

  const result = await repository.query({
    limit: 10,
    from: '2026-03-31T11:00:00.000Z',
    to: '2026-03-31T13:00:00.000Z',
  });
  const detail = await repository.getByRequestId('req-new');

  assert(result.count === 1, 'Expected one event in filtered time range');
  assert(result.items[0].requestId === 'req-new', 'Expected newest matching request');
  assert(detail?.requestId === 'req-new', 'Expected request detail lookup to succeed');
});
