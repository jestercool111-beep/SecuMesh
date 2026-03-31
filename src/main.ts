import { createHandler } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();

console.log(
  `SecuMesh gateway listening on http://${config.host}:${config.port} (upstream: ${
    config.upstreamBaseUrl || 'not-configured'
  })`,
);

Deno.serve(
  {
    hostname: config.host,
    port: config.port,
  },
  createHandler(config),
);
