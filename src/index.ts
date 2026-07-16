import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { createRuntime, startRuntime, stopRuntime } from './runtime.js';

const config = loadConfig();
const runtime = createRuntime(config);
const app = createApp(runtime);
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await stopRuntime(runtime);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await startRuntime(runtime);
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ error }, 'Startup failed');
  await shutdown('STARTUP_FAILURE');
  process.exitCode = 1;
}
