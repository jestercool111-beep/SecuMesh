import { SensitiveProcessor } from './sensitive_processor.ts';
import { InMemorySessionStore } from '../store/session_store.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test('SensitiveProcessor masks and restores CN sensitive values', async () => {
  const processor = new SensitiveProcessor(new InMemorySessionStore(1800));
  const sessionId = 'session-test';
  const input = {
    model: 'demo-model',
    messages: [
      {
        role: 'user',
        content: 'Phone 13800138000, id 11010519491231002X.',
      },
    ],
  };

  const result = await processor.sanitizeRequest(sessionId, input);
  const maskedContent = result.body.messages[0].content;

  assert(typeof maskedContent === 'string', 'Expected masked content to stay as string');
  assert(maskedContent.includes('[PHONE_001]'), 'Expected phone placeholder');
  assert(maskedContent.includes('[IDCARD_001]'), 'Expected ID placeholder');

  const restored = await processor.restoreText(sessionId, maskedContent);
  assert(restored.includes('13800138000'), 'Expected phone to be restored');
  assert(restored.includes('11010519491231002X'), 'Expected ID to be restored');
});

Deno.test('SensitiveProcessor restores placeholders across stream chunks', async () => {
  const processor = new SensitiveProcessor(new InMemorySessionStore(1800));
  const sessionId = 'stream-test';
  await processor.sanitizeRequest(sessionId, {
    model: 'demo-model',
    messages: [{ role: 'user', content: 'Call me at 13800138000' }],
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"delta":"[PH'));
      controller.enqueue(new TextEncoder().encode('ONE_001]"}\n\n'));
      controller.close();
    },
  });

  const restored = await processor.createRestoreStream(sessionId, stream);
  const text = await new Response(restored).text();
  assert(text.includes('13800138000'), 'Expected streaming output to be restored');
});
