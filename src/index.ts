import { chmod, rm } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { createRuntime, startRuntime, stopRuntime } from './runtime.js';
import {
  acquireProcessLock,
  type ProcessLock,
} from './runtime/process-lock.js';

const config = loadConfig();
const runtime = createRuntime(config);
const app = createApp(runtime);
let stopping = false;
let processLock: ProcessLock | null = null;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await stopRuntime(runtime);
  if (config.api.socketPath) await rm(config.api.socketPath, { force: true });
  await processLock?.release();
  processLock = null;
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  if (process.env.PRAXRAIL_PID_FILE) {
    processLock = await acquireProcessLock(process.env.PRAXRAIL_PID_FILE);
  }
  await startRuntime(runtime);
  if (config.api.socketPath) {
    await rm(config.api.socketPath, { force: true });
    await app.listen({ path: config.api.socketPath });
    await chmod(config.api.socketPath, 0o600);
  } else {
    await app.listen({ host: config.host, port: config.port });
  }
} catch (error) {
  app.log.fatal({ error }, 'Startup failed');
  await shutdown('STARTUP_FAILURE');
  process.exitCode = 1;
}
