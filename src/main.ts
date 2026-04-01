import { createHandler } from './app.ts';
import { loadConfig, validateConfig } from './config.ts';

const config = loadConfig();
const validation = validateConfig(config);

if (validation.errors.length > 0) {
  console.error('SecuMesh configuration errors:');
  for (const error of validation.errors) {
    console.error(`- ${error}`);
  }
  Deno.exit(1);
}

if (validation.warnings.length > 0) {
  console.warn('SecuMesh configuration warnings:');
  for (const warning of validation.warnings) {
    console.warn(`- ${warning}`);
  }
}

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
