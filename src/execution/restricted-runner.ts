import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { assertNoSymlinkEscape } from '../repositories/path-policy.js';

const forbiddenEnvironment =
  /(?:TOKEN|SECRET|PASSWORD|PRIVATE|DATABASE|OPENAI|CODEX|GITHUB|TELEGRAM|AWS|AZURE|GOOGLE)/i;

export type ExecutionFailure =
  | 'NONE'
  | 'COMMAND'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'OUTPUT_LIMIT'
  | 'DISK_LIMIT'
  | 'INFRASTRUCTURE';

export interface RestrictedCommand {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  outputLimitBytes: number;
  diskLimitBytes: number;
  environment?: Record<string, string>;
  container?: {
    image: string;
    cpus: number;
    memoryMb: number;
    processLimit: number;
    network: 'none' | 'bridge';
  };
}

export interface ExecutionResult {
  startedAt: Date;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failure: ExecutionFailure;
  truncated: boolean;
}

async function directorySize(root: string, limit: number): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const item = path.join(directory, entry.name);
      const itemStat = await stat(item);
      if (itemStat.isDirectory()) pending.push(item);
      else if (itemStat.isFile()) total += itemStat.size;
      if (total > limit) return total;
    }
  }
  return total;
}

function safeEnvironment(
  input: Record<string, string> = {},
): NodeJS.ProcessEnv {
  for (const key of Object.keys(input)) {
    if (forbiddenEnvironment.test(key)) {
      throw new Error(`Environment variable ${key} is forbidden`);
    }
  }
  return {
    PATH: process.env.PATH,
    HOME: '/tmp/praxrail-runner-home',
    LANG: 'C.UTF-8',
    CI: 'true',
    ...input,
  };
}

export class RestrictedRunner {
  constructor(
    private readonly workspaceRoot: string,
    private readonly options: { allowHostExecution?: boolean } = {},
  ) {}

  async execute(
    command: RestrictedCommand,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    if (!command.container && !this.options.allowHostExecution) {
      throw new Error('Host command execution is disabled');
    }
    if (command.container) {
      if (command.container.network !== 'none') {
        throw new Error('Verification containers cannot access the network');
      }
      if (!/@sha256:[a-f0-9]{64}$/i.test(command.container.image)) {
        throw new Error('Verification container image must be digest-pinned');
      }
    }
    const cwd = await assertNoSymlinkEscape(this.workspaceRoot, command.cwd);
    const initialSize = await directorySize(cwd, command.diskLimitBytes);
    if (initialSize > command.diskLimitBytes) {
      return {
        startedAt: new Date(),
        durationMs: 0,
        exitCode: null,
        stdout: '',
        stderr: 'Workspace already exceeds its disk limit',
        failure: 'DISK_LIMIT',
        truncated: false,
      };
    }
    const environment = safeEnvironment(command.environment);
    const invocation = command.container
      ? {
          executable: 'docker',
          args: [
            'run',
            '--rm',
            '--read-only',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--network',
            command.container.network,
            '--cpus',
            String(command.container.cpus),
            '--memory',
            `${command.container.memoryMb}m`,
            '--pids-limit',
            String(command.container.processLimit),
            '--tmpfs',
            '/tmp:rw,noexec,nosuid,size=64m',
            '--mount',
            `type=bind,source=${cwd},target=/workspace`,
            '--workdir',
            '/workspace',
            command.container.image,
            command.executable,
            ...command.args,
          ],
        }
      : { executable: command.executable, args: command.args };
    const startedAt = new Date();
    try {
      const result = await execa(invocation.executable, invocation.args, {
        cwd,
        env: environment,
        extendEnv: false,
        reject: false,
        timeout: command.timeoutMs,
        ...(signal ? { cancelSignal: signal } : {}),
        forceKillAfterDelay: 2_000,
        maxBuffer: command.outputLimitBytes,
      });
      const finalSize = await directorySize(cwd, command.diskLimitBytes);
      const failure: ExecutionFailure =
        finalSize > command.diskLimitBytes
          ? 'DISK_LIMIT'
          : result.timedOut
            ? 'TIMEOUT'
            : result.isCanceled
              ? 'CANCELLED'
              : result.isMaxBuffer
                ? 'OUTPUT_LIMIT'
                : result.exitCode === 0
                  ? 'NONE'
                  : 'COMMAND';
      return {
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        exitCode: result.exitCode ?? null,
        stdout: result.stdout.slice(0, command.outputLimitBytes),
        stderr: result.stderr.slice(0, command.outputLimitBytes),
        failure,
        truncated: result.isMaxBuffer,
      };
    } catch (error) {
      const executionError = error as {
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        timedOut?: boolean;
        isCanceled?: boolean;
        isMaxBuffer?: boolean;
      };
      const failure: ExecutionFailure = signal?.aborted
        ? 'CANCELLED'
        : executionError.timedOut
          ? 'TIMEOUT'
          : executionError.isCanceled
            ? 'CANCELLED'
            : executionError.isMaxBuffer
              ? 'OUTPUT_LIMIT'
              : 'INFRASTRUCTURE';
      return {
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        exitCode: executionError.exitCode ?? null,
        stdout: (executionError.stdout ?? '').slice(
          0,
          command.outputLimitBytes,
        ),
        stderr:
          executionError.stderr?.slice(0, command.outputLimitBytes) ??
          (error instanceof Error
            ? error.message.slice(0, 2_000)
            : 'Runner failure'),
        failure,
        truncated: executionError.isMaxBuffer ?? false,
      };
    }
  }
}
