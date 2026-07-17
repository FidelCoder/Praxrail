import http from 'node:http';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface RuntimePaths {
  directory: string;
  pidFile: string;
  logFile: string;
  socketFile: string;
}

export function runtimePaths(directory?: string): RuntimePaths {
  const root = path.resolve(
    directory ??
      process.env.PRAXRAIL_STATE_HOME ??
      path.join(
        process.env.XDG_STATE_HOME ??
          path.join(os.homedir(), '.local', 'state'),
        'praxrail',
      ),
  );
  return {
    directory: root,
    pidFile: path.join(root, 'runtime.pid'),
    logFile: path.join(root, 'runtime.log'),
    socketFile: path.join(root, 'runtime.sock'),
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function socketReady(socketFile: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request = http.request(
      { socketPath: socketFile, path: '/health/ready', method: 'GET' },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.setTimeout(1_000, () => request.destroy());
    request.once('error', () => resolve(false));
    request.end();
  });
}

export async function readRuntimeLog(
  paths: RuntimePaths,
  maximumBytes = 256 * 1024,
): Promise<string> {
  try {
    const content = await readFile(paths.logFile);
    return content.subarray(-maximumBytes).toString('utf8');
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return '';
    }
    throw error;
  }
}

export async function runtimePid(paths: RuntimePaths): Promise<number | null> {
  try {
    const pid = Number((await readFile(paths.pidFile, 'utf8')).trim());
    if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return null;
    return pid;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

export async function startRuntimeProcess(input: {
  paths: RuntimePaths;
  entry: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<number> {
  const running = await runtimePid(input.paths);
  if (running)
    throw new Error(`Praxrail runtime is already running as PID ${running}`);
  await mkdir(input.paths.directory, { recursive: true, mode: 0o700 });
  await rm(input.paths.pidFile, { force: true });
  const log = await open(input.paths.logFile, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [input.entry], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: {
        ...process.env,
        ...input.environment,
        PRAXRAIL_PID_FILE: input.paths.pidFile,
        API_ENABLED: 'true',
        API_SOCKET_PATH: input.paths.socketFile,
      },
    });
    child.unref();
    const deadline = Date.now() + (input.timeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      const pid = await runtimePid(input.paths);
      if (pid && (await socketReady(input.paths.socketFile))) return pid;
      if (!pid && child.exitCode !== null) {
        throw new Error(`Praxrail runtime exited with code ${child.exitCode}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (child.pid) process.kill(child.pid, 'SIGTERM');
    throw new Error('Praxrail runtime did not become ready before the timeout');
  } finally {
    await log.close();
  }
}

export async function stopRuntimeProcess(
  paths: RuntimePaths,
  timeoutMs = 15_000,
): Promise<boolean> {
  const pid = await runtimePid(paths);
  if (!pid) {
    await rm(paths.pidFile, { force: true });
    return false;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      await rm(paths.pidFile, { force: true });
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Praxrail runtime PID ${pid} did not stop before the timeout`,
  );
}
