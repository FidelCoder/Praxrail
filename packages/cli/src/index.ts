import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PraxrailClient,
  PraxrailClientError,
  ProfileStore,
  type PraxrailClientOptions,
} from '@praxrail/client';
import { runProductCommand } from './product-commands.js';
import {
  readRuntimeLog,
  runtimePaths,
  runtimePid,
  startRuntimeProcess,
  stopRuntimeProcess,
} from './lifecycle.js';

export interface CliIo {
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
}

export interface CliDependencies {
  createProfileStore?: () => Pick<ProfileStore, 'get' | 'list' | 'use'> &
    Partial<Pick<ProfileStore, 'save' | 'remove'>>;
  createClient?: (
    options: PraxrailClientOptions,
  ) => Pick<PraxrailClient, 'runtimeStatus'> & Partial<PraxrailClient>;
  runtimePaths?: typeof runtimePaths;
  runtimePid?: typeof runtimePid;
  startRuntimeProcess?: typeof startRuntimeProcess;
  stopRuntimeProcess?: typeof stopRuntimeProcess;
  readRuntimeLog?: typeof readRuntimeLog;
  spawnForeground?: typeof spawnForeground;
  spawnShell?: typeof spawnShell;
  runtimeEntry?: () => string;
}

class CliUsageError extends Error {}

function timeoutValue(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new CliUsageError('Timeout must be an integer in milliseconds');
  }
  const timeout = Number(value);
  if (timeout < 1 || timeout > 600_000) {
    throw new CliUsageError(
      'Timeout must be between 1 and 600000 milliseconds',
    );
  }
  return timeout;
}

function asClientError(error: unknown): PraxrailClientError | null {
  if (error instanceof PraxrailClientError) return error;
  if (!(error instanceof Error) || error.name !== 'PraxrailClientError') {
    return null;
  }
  const candidate = error as Error & { status?: unknown; detail?: unknown };
  if (
    typeof candidate.status !== 'number' ||
    typeof candidate.detail !== 'object' ||
    candidate.detail === null ||
    !('error' in candidate.detail) ||
    !('retryable' in candidate.detail)
  ) {
    return null;
  }
  return candidate as PraxrailClientError;
}

function exitCode(error: unknown): number {
  if (error instanceof CliUsageError) return 2;
  const clientError = asClientError(error);
  if (clientError) {
    if (clientError.status === 401) return 5;
    if (clientError.status === 403) return 6;
    if (clientError.status === 404) return 3;
    if (clientError.status === 409) return 7;
    if (clientError.detail.retryable) return 8;
  }
  if (
    error instanceof Error &&
    'code' in error &&
    String((error as NodeJS.ErrnoException).code).startsWith('ERR_PARSE_ARGS')
  ) {
    return 2;
  }
  return 1;
}

const VERSION = '0.3.0';
const help = `Praxrail ${VERSION}

Usage: praxrail [--profile NAME] [--json] <command>

Commands:
  version                    Print the CLI version
  init NAME                  Configure the first connection profile
  login NAME                 Add or replace a connection profile
  logout NAME                Remove a connection profile
  doctor                     Diagnose runtime, workers, schema, and channels
  runtime serve              Run the compatibility runtime in the foreground
  runtime start              Start the runtime in the background
  runtime stop               Stop the managed runtime
  runtime restart            Restart the managed runtime
  runtime status             Query runtime process and API status
  runtime logs               Print the bounded managed-runtime log tail
  profile list               List connection profiles
  profile use NAME           Select a connection profile
  project create|list|show|update|archive
  repo add|inspect|approve|list|show|disable|remove
  task create|list|show|clarify|prioritize|pause|resume|cancel|retry|abandon|archive
  task status|watch|logs|events|attempts|costs|verification|findings
  task ownership|attach|shell|return|recover|diff|check|review|fix|publish|pull-request
  channel setup|link|verify|status|test|preference|rotate|disable|revoke
  approval approve|reject      Decide a pending approval with a one-time token
  upgrade preflight          Check whether an upgrade may proceed
  support bundle             Generate a redacted diagnostic bundle

Global flags:
  --profile NAME             Select a connection profile
  --json                     Emit stable JSON output
  --quiet                    Suppress successful human output
  --no-color                 Disable color output
  --non-interactive          Refuse interactive prompts
  --timeout MILLISECONDS     Set request timeout
  --dry-run                  Validate a mutation without writing
  --yes                      Confirm a destructive or high-risk command
  --follow                   Follow a durable event or output cursor
  --version                  Print the CLI version
  --help                     Show this help
`;

function runtimeEntry(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../dist/index.js',
  );
}

export async function runCli(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  dependencies: CliDependencies = {},
): Promise<number> {
  const jsonRequested = argv.includes('--json');
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        profile: { type: 'string' },
        json: { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        color: { type: 'boolean', default: true },
        'non-interactive': { type: 'boolean', default: false },
        timeout: { type: 'string' },
        version: { type: 'boolean', short: 'V', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        endpoint: { type: 'string' },
        token: { type: 'string' },
        project: { type: 'string' },
        repository: { type: 'string' },
        name: { type: 'string' },
        slug: { type: 'string' },
        status: { type: 'string' },
        title: { type: 'string' },
        request: { type: 'string' },
        reason: { type: 'string' },
        priority: { type: 'string' },
        budget: { type: 'string' },
        limit: { type: 'string' },
        cursor: { type: 'string' },
        destination: { type: 'string' },
        code: { type: 'string' },
        identity: { type: 'string' },
        'full-name': { type: 'string' },
        'clone-url': { type: 'string' },
        'default-branch': { type: 'string' },
        'worker-profile': { type: 'string' },
        'mirror-path': { type: 'string' },
        'credential-ref': { type: 'string' },
        'minimum-severity': { type: 'string' },
        mode: { type: 'string' },
        'quiet-start': { type: 'string' },
        'quiet-end': { type: 'string' },
        timezone: { type: 'string' },
        escalation: { type: 'string' },
        'fencing-token': { type: 'string' },
        approval: { type: 'string' },
        direction: { type: 'string' },
        lease: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'include-archived': { type: 'boolean', default: false },
        follow: { type: 'boolean', default: false },
        enable: { type: 'boolean' },
        disable: { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
      },
    });
    const json = parsed.values.json;
    const quiet = parsed.values.quiet;
    const print = (value: unknown, human: string): void => {
      if (json) io.stdout.write(`${JSON.stringify(value)}\n`);
      else if (!quiet) io.stdout.write(`${human}\n`);
    };
    const [command, action, argument, ...extra] = parsed.positionals;
    if (parsed.values.version) {
      print({ version: VERSION }, VERSION);
      return 0;
    }
    if (parsed.values.help || !command) {
      io.stdout.write(help);
      return 0;
    }

    if (command === 'version') {
      print({ version: VERSION }, VERSION);
      return 0;
    }
    const createStore =
      dependencies.createProfileStore ?? (() => new ProfileStore());
    if (command === 'init' || command === 'login') {
      const store = createStore();
      if (!store.save) throw new Error('Profile storage is unavailable');
      const name = action ?? 'default';
      const endpoint = parsed.values.endpoint;
      const token = parsed.values.token;
      if (!endpoint || !token) {
        throw new CliUsageError(
          'login requires --endpoint and --token; tokens are never prompted or printed',
        );
      }
      await store.save(
        name,
        {
          endpoint,
          token,
          allowInsecureRemote: false,
        },
        true,
      );
      print(
        { profile: name, endpoint },
        `Profile ${name} configured for ${endpoint}`,
      );
      return 0;
    }
    if (command === 'logout') {
      const store = createStore();
      if (!store.remove) throw new Error('Profile storage is unavailable');
      if (!action) throw new CliUsageError('logout requires a profile name');
      await store.remove(action);
      print({ profile: action, removed: true }, `Profile ${action} removed`);
      return 0;
    }
    const paths = (dependencies.runtimePaths ?? runtimePaths)();
    if (command === 'runtime') {
      if (action === 'serve') {
        const child = (dependencies.spawnForeground ?? spawnForeground)(
          (dependencies.runtimeEntry ?? runtimeEntry)(),
          paths.pidFile,
        );
        return await child;
      }
      if (action === 'start') {
        const pid = await (
          dependencies.startRuntimeProcess ?? startRuntimeProcess
        )({
          paths,
          entry: (dependencies.runtimeEntry ?? runtimeEntry)(),
        });
        print({ running: true, pid }, `Praxrail runtime started as PID ${pid}`);
        return 0;
      }
      if (action === 'stop') {
        const stopped = await (
          dependencies.stopRuntimeProcess ?? stopRuntimeProcess
        )(paths);
        print(
          { running: false, stopped },
          stopped
            ? 'Praxrail runtime stopped'
            : 'Praxrail runtime is not running',
        );
        return 0;
      }
      if (action === 'restart') {
        await (dependencies.stopRuntimeProcess ?? stopRuntimeProcess)(paths);
        const pid = await (
          dependencies.startRuntimeProcess ?? startRuntimeProcess
        )({
          paths,
          entry: (dependencies.runtimeEntry ?? runtimeEntry)(),
        });
        print(
          { running: true, pid },
          `Praxrail runtime restarted as PID ${pid}`,
        );
        return 0;
      }
      if (action === 'status') {
        const pid = await (dependencies.runtimePid ?? runtimePid)(paths);
        if (!pid) {
          print({ running: false }, 'Praxrail runtime is not running');
          return 3;
        }
        const store = (
          dependencies.createProfileStore ?? (() => new ProfileStore())
        )();
        const profile = await store
          .get(parsed.values.profile)
          .catch(() => null);
        if (!profile) {
          print(
            { running: true, pid },
            `Praxrail runtime is running as PID ${pid}`,
          );
          return 0;
        }
        const createClient =
          dependencies.createClient ??
          ((options: PraxrailClientOptions) => new PraxrailClient(options));
        const timeoutMs = timeoutValue(parsed.values.timeout);
        const client = createClient({
          ...profile,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        const status = await client.runtimeStatus();
        print(
          { running: true, pid, status },
          `Praxrail runtime ${status.status.toLowerCase()} as PID ${pid}`,
        );
        return status.status === 'READY' ? 0 : 4;
      }
      if (action === 'logs') {
        const content = await (dependencies.readRuntimeLog ?? readRuntimeLog)(
          paths,
        );
        print({ content }, content || 'No runtime logs available');
        return 0;
      }
    }
    if (command === 'profile') {
      const store = (
        dependencies.createProfileStore ?? (() => new ProfileStore())
      )();
      if (action === 'list') {
        const profiles = await store.list();
        print(
          profiles,
          Object.keys(profiles.profiles).join('\n') || 'No profiles configured',
        );
        return 0;
      }
      if (action === 'use' && argument) {
        await store.use(argument);
        print({ current: argument }, `Using profile ${argument}`);
        return 0;
      }
    }
    if (
      ![
        'doctor',
        'diagnose',
        'project',
        'repo',
        'repository',
        'task',
        'channel',
        'notify',
        'approval',
        'upgrade',
        'support',
      ].includes(command)
    ) {
      throw new CliUsageError('Unknown command. Run praxrail --help.');
    }
    const destructive =
      (command === 'project' && action === 'archive') ||
      ((command === 'repo' || command === 'repository') &&
        ['approve', 'remove'].includes(action ?? '')) ||
      (command === 'task' &&
        ['cancel', 'abandon', 'archive', 'publish'].includes(action ?? '')) ||
      ((command === 'channel' || command === 'notify') &&
        ['rotate', 'revoke'].includes(action ?? '')) ||
      (command === 'approval' && ['approve', 'reject'].includes(action ?? ''));
    if (destructive && !parsed.values.yes) {
      throw new CliUsageError(
        'This command requires --yes after reviewing the target and reason',
      );
    }
    const store = createStore();
    const profile = await store.get(parsed.values.profile);
    const timeoutMs = timeoutValue(parsed.values.timeout);
    const createClient =
      dependencies.createClient ??
      ((options: PraxrailClientOptions) => new PraxrailClient(options));
    const client = createClient({
      ...profile,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }) as PraxrailClient;
    const result = await runProductCommand({
      command,
      action,
      argument,
      extra,
      options: parsed.values,
      client,
      emit: print,
      spawnShell: dependencies.spawnShell ?? spawnShell,
    });
    if (result) {
      if (result.human || result.value !== null) {
        print(result.value, result.human);
      }
      return result.exitCode ?? 0;
    }
    throw new CliUsageError('Unknown command. Run praxrail --help.');
  } catch (error) {
    const code = exitCode(error);
    const message = error instanceof Error ? error.message : 'Praxrail failed';
    const clientError = asClientError(error);
    const errorName = clientError
      ? clientError.detail.error
      : code === 2
        ? 'USAGE_ERROR'
        : 'RUNTIME_ERROR';
    if (jsonRequested) {
      io.stderr.write(
        `${JSON.stringify({ error: errorName, message, exitCode: code })}\n`,
      );
    } else {
      io.stderr.write(`${message}\n`);
    }
    return code;
  }
}

async function spawnForeground(
  entry: string,
  pidFile: string,
): Promise<number> {
  const { spawn } = await import('node:child_process');
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      stdio: 'inherit',
      env: { ...process.env, PRAXRAIL_PID_FILE: pidFile },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

async function spawnShell(context: {
  path: string;
  taskId: string;
  taskKey: string;
  repository: string;
  branch: string;
  fencingToken: string;
}): Promise<number> {
  const { spawn } = await import('node:child_process');
  const shell = process.env.SHELL;
  if (!shell || !['bash', 'zsh'].includes(path.basename(shell))) {
    throw new CliUsageError(
      'Interactive handoff requires SHELL to reference bash or zsh',
    );
  }
  const env = Object.fromEntries(
    ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TERM', 'USER']
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return new Promise<number>((resolve, reject) => {
    const child = spawn(shell, ['-i'], {
      cwd: context.path,
      stdio: 'inherit',
      env: {
        ...env,
        PRAXRAIL_TASK_ID: context.taskId,
        PRAXRAIL_TASK_KEY: context.taskKey,
        PRAXRAIL_REPOSITORY: context.repository,
        PRAXRAIL_BRANCH: context.branch,
        PRAXRAIL_FENCING_TOKEN: context.fencingToken,
        PRAXRAIL_HANDOFF: 'HUMAN_OWNED',
        PS1: `[praxrail:${context.taskKey}] ${process.env.PS1 ?? '\\u@\\h:\\w\\$ '}`,
      },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

export {
  readRuntimeLog,
  runtimePaths,
  runtimePid,
  startRuntimeProcess,
  stopRuntimeProcess,
} from './lifecycle.js';
