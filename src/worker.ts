const topicPath = Deno.env.get('AUDIT_TOPIC_PATH') ?? 'logs/audit-topic.jsonl';

console.log(`SecuMesh worker started. Watching topic file: ${topicPath}`);
console.log('This MVP worker is a local-dev bridge for the future Kafka -> PostgreSQL pipeline.');
console.log('In the next phase it will consume Kafka audit events and persist them to PostgreSQL.');

let lastSize = 0;

for (;;) {
  try {
    const stat = await Deno.stat(topicPath);
    if (stat.size > lastSize) {
      const text = await Deno.readTextFile(topicPath);
      const lines = text.split(/\r?\n/).filter(Boolean);
      const newLines = lines.slice(Math.max(0, lines.length - 10));
      console.log(`Observed ${newLines.length} recent audit event(s) in local topic file.`);
      lastSize = stat.size;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.error('Worker error:', error);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 5000));
}
