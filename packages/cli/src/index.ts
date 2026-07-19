import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PraxrailClient,
  PraxrailClientError,
  ProfileStore,
  type PraxrailClientOptions,
} from 'praxrail-client';
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

type ProfileStoreLike = Pick<ProfileStore, 'get' | 'list' | 'use'> &
  Partial<Pick<ProfileStore, 'save' | 'remove'>>;

type InteractiveLines = AsyncIterable<string> | Iterable<string>;

export interface CliDependencies {
  createProfileStore?: () => ProfileStoreLike;
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
  interactiveLines?: InteractiveLines;
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

const VERSION = '0.3.6';
const help = `Praxrail ${VERSION}

Usage: pxr [--profile NAME] [--json] <command>

Commands:
  version                    Print the CLI version
  start                      Start the engine, select a model, and open the prompt in a TTY
  stop                       Stop the local engine
  restart                    Restart the local engine
  status                     Query local engine status
  logs                       Print local engine logs
  chat                       Open an interactive Praxrail prompt
  interactive                 Alias for chat
  repl                        Alias for chat
  ask REQUEST                Create a coding task from terminal text
  command REQUEST            Alias for ask
  watch TASK                 Follow task events
  output TASK                Follow task output
  shell TASK                 Open a human-owned task workspace shell
  init NAME                  Configure the first connection profile
  login NAME                 Add or replace a connection profile
  logout NAME                Remove a connection profile
  doctor                     Diagnose runtime, workers, schema, and channels
  runtime serve              Run the compatibility runtime in the foreground
  runtime start              Start the engine in the background
  runtime stop               Stop the managed engine
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
  --model MODEL              Select the coding model for pxr start
  --base-url URL             Use a custom OpenAI-compatible base URL
  --api-key-env NAME         Read the builder API key from a named env var
  --review-api-key-env NAME  Read the reviewer API key from a named env var
  --dry-run                  Validate a mutation without writing
  --yes                      Confirm a destructive or high-risk command
  --follow                   Follow a durable event or output cursor
  --version                  Print the CLI version
  --help                     Show this help

Interactive mode:
  In a real terminal, pxr start starts the engine and opens the prompt.
  Run pxr or pxr chat --project <id> --repository <id> to open it later.
  Plain text creates a task. Slash commands include /help, /status, /tasks,
  /use <project-id> <repository-id>, /project <id>, /repo <id>, and /exit.
  Use pxr start --non-interactive or pxr start --json for scripts.
`;

function runtimeEntry(): string {
  const cliDist = path.dirname(fileURLToPath(import.meta.url));
  const packagedRuntime = path.resolve(cliDist, '../runtime/index.js');
  if (existsSync(packagedRuntime)) return packagedRuntime;
  return path.resolve(cliDist, '../../../dist/index.js');
}

const localProfileName = 'local';
const lifecycleAliases = new Set([
  'serve',
  'start',
  'stop',
  'restart',
  'status',
  'logs',
]);

function localEndpoint(paths: ReturnType<typeof runtimePaths>): string {
  return `unix://${paths.socketFile}`;
}

function localToken(): string {
  return `pxr_${randomBytes(32).toString('base64url')}`;
}

function truthyEnvironment(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value ?? '');
}

function unquoteEnvironmentValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n');
  }
  const comment = trimmed.indexOf(' #');
  return comment === -1 ? trimmed : trimmed.slice(0, comment).trimEnd();
}

function readDotEnv(directory = process.cwd()): NodeJS.ProcessEnv {
  const filename = path.join(directory, '.env');
  if (!existsSync(filename)) return {};
  const environment: NodeJS.ProcessEnv = {};
  for (const rawLine of readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    const key = match?.[1];
    if (!key) continue;
    environment[key] = unquoteEnvironmentValue(match[2] ?? '');
  }
  return environment;
}

async function promptForModel(
  defaultModel: string,
): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const { createInterface } = await import('node:readline/promises');
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await readline.question(`Model [${defaultModel}]: `);
    return answer.trim() || defaultModel;
  } finally {
    readline.close();
  }
}

async function runtimeStartContext(input: {
  options: {
    model?: string | undefined;
    'base-url'?: string | undefined;
    'api-key-env'?: string | undefined;
    'review-api-key-env'?: string | undefined;
    'non-interactive'?: boolean | undefined;
  };
  paths: ReturnType<typeof runtimePaths>;
  store: ProfileStoreLike;
}): Promise<{
  endpoint: string;
  environment: NodeJS.ProcessEnv;
  model?: string | undefined;
  profile: string;
  token: string;
}> {
  const base = { ...readDotEnv(), ...process.env };
  const endpoint = localEndpoint(input.paths);
  const existing = await input.store.get(localProfileName).catch(() => null);
  const token = base.API_BOOTSTRAP_TOKEN ?? existing?.token ?? localToken();
  const explicitApiKeyName = input.options['api-key-env'];
  const explicitReviewApiKeyName = input.options['review-api-key-env'];
  const builderApiKey = explicitApiKeyName
    ? base[explicitApiKeyName]
    : (base.CODEX_BUILDER_API_KEY ?? base.OPENAI_API_KEY ?? base.CODEX_API_KEY);
  const reviewerApiKey = explicitReviewApiKeyName
    ? base[explicitReviewApiKeyName]
    : base.CODEX_REVIEWER_API_KEY;
  const baseUrl =
    input.options['base-url'] ?? base.CODEX_BASE_URL ?? base.OPENAI_BASE_URL;
  let model = input.options.model ?? base.CODEX_MODEL ?? base.OPENAI_MODEL;
  if (!model && builderApiKey && !input.options['non-interactive']) {
    model = await promptForModel('gpt-5.5');
  }
  const wantsCodex =
    truthyEnvironment(base.CODEX_ENABLED) ||
    Boolean(model) ||
    Boolean(builderApiKey);
  const environment: NodeJS.ProcessEnv = {
    ...base,
    API_BOOTSTRAP_ACTOR_ID: base.API_BOOTSTRAP_ACTOR_ID ?? 'local-owner',
    API_BOOTSTRAP_ROLE: base.API_BOOTSTRAP_ROLE ?? 'OWNER',
    API_BOOTSTRAP_TOKEN: token,
  };
  if (wantsCodex) {
    if (!builderApiKey || !reviewerApiKey) {
      throw new CliUsageError(
        'pxr start with a model requires CODEX_BUILDER_API_KEY and CODEX_REVIEWER_API_KEY; use --api-key-env and --review-api-key-env to point at different env vars',
      );
    }
    if (builderApiKey === reviewerApiKey) {
      throw new CliUsageError(
        'pxr start requires distinct builder and reviewer API keys by the current security policy',
      );
    }
    if (!model) {
      throw new CliUsageError(
        'pxr start requires --model, CODEX_MODEL, or OPENAI_MODEL when model access is configured',
      );
    }
    environment.CODEX_ENABLED = 'true';
    environment.CODEX_BUILDER_API_KEY = builderApiKey;
    environment.CODEX_REVIEWER_API_KEY = reviewerApiKey;
    environment.CODEX_MODEL = model;
    if (baseUrl) environment.CODEX_BASE_URL = baseUrl;
  }
  return { endpoint, environment, model, profile: localProfileName, token };
}

function requestText(parts: readonly (string | undefined)[]): string {
  return parts
    .filter(
      (part): part is string =>
        typeof part === 'string' && part.trim().length > 0,
    )
    .join(' ')
    .trim();
}

function defaultTaskTitle(request: string): string {
  const title = request.split(/\r?\n/)[0]?.trim() ?? '';
  return title.length > 80
    ? `${title.slice(0, 77)}...`
    : title || 'Terminal command';
}

const minimumNode = { major: 22, minor: 12 };

function assertSupportedRuntimeNode(): void {
  const [major = 0, minor = 0] = process.versions.node
    .split('.')
    .map((part) => Number(part));
  if (
    major > minimumNode.major ||
    (major === minimumNode.major && minor >= minimumNode.minor)
  ) {
    return;
  }
  throw new CliUsageError(
    `Praxrail runtime requires Node.js ${minimumNode.major}.${minimumNode.minor}+; current Node is ${process.versions.node}. Upgrade Node or run with: npx -y -p node@22 -p praxrail@latest pxr ...`,
  );
}

const interactiveHelp = `Interactive Praxrail commands:
  /help                         Show this help
  /status                       Show runtime status
  /tasks                        List current tasks
  /use <project-id> <repo-id>    Set project and repository defaults
  /project <project-id>          Set the default project
  /repo <repo-id>                Set the default repository
  /exit                         Leave the prompt

Plain text creates a coding task using the current project/repository defaults.
Start with: pxr chat --project <project-id> --repository <repository-id>
`;

function recordText(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field : '';
}

function interactiveTaskHuman(task: unknown): string {
  if (!task || typeof task !== 'object') return 'Task queued';
  const record = task as Record<string, unknown>;
  const key = recordText(record, 'taskKey') || recordText(record, 'id');
  const status = recordText(record, 'status');
  const title = recordText(record, 'title');
  return [key, status, title].filter(Boolean).join('  ') || 'Task queued';
}

async function* promptInteractiveLines(io: CliIo): AsyncGenerator<string> {
  const { createInterface } = await import('node:readline/promises');
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    for (;;) {
      try {
        yield await readline.question('pxr> ');
      } catch {
        io.stdout.write('\n');
        return;
      }
    }
  } finally {
    readline.close();
  }
}

async function runInteractiveSession(input: {
  client: PraxrailClient;
  io: CliIo;
  options: {
    project?: string | undefined;
    repository?: string | undefined;
    'dry-run'?: boolean | undefined;
  };
  lines?: InteractiveLines | undefined;
}): Promise<number> {
  let project = input.options.project;
  let repository = input.options.repository;
  const lines = input.lines ?? promptInteractiveLines(input.io);
  input.io.stdout.write(
    'Praxrail interactive mode. Type /help for commands, /exit to leave.\n',
  );
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (
      line === '/exit' ||
      line === '/quit' ||
      line === 'exit' ||
      line === 'quit'
    ) {
      input.io.stdout.write('Leaving Praxrail interactive mode.\n');
      return 0;
    }
    if (line === '/help' || line === 'help') {
      input.io.stdout.write(interactiveHelp);
      continue;
    }
    if (line.startsWith('/use ')) {
      const [, nextProject, nextRepository] = line.split(/\s+/, 3);
      if (!nextProject || !nextRepository) {
        input.io.stderr.write('Usage: /use <project-id> <repository-id>\n');
        continue;
      }
      project = nextProject;
      repository = nextRepository;
      input.io.stdout.write(
        `Using project ${project} and repository ${repository}.\n`,
      );
      continue;
    }
    if (line.startsWith('/project ')) {
      project = line.slice('/project '.length).trim();
      input.io.stdout.write(`Using project ${project}.\n`);
      continue;
    }
    if (line.startsWith('/repo ') || line.startsWith('/repository ')) {
      repository = line.replace(/^\/(?:repo|repository)\s+/, '').trim();
      input.io.stdout.write(`Using repository ${repository}.\n`);
      continue;
    }
    if (line === '/status') {
      const status = await input.client.runtimeStatus();
      input.io.stdout.write(
        `Runtime ${status.status.toLowerCase()} (${status.mode}).\n`,
      );
      continue;
    }
    if (line === '/tasks') {
      const tasks = await input.client.listTaskDetails({
        ...(project ? { projectId: project } : {}),
        ...(repository ? { repositoryId: repository } : {}),
        limit: 20,
        includeArchived: false,
      });
      if (tasks.length === 0) input.io.stdout.write('No matching tasks.\n');
      else {
        for (const task of tasks) {
          input.io.stdout.write(`${interactiveTaskHuman(task)}\n`);
        }
      }
      continue;
    }
    if (line.startsWith('/')) {
      input.io.stderr.write(
        `Unknown interactive command: ${line}. Type /help.\n`,
      );
      continue;
    }
    if (!project || !repository) {
      input.io.stderr.write(
        'Set project and repository first: /use <project-id> <repository-id> or start with --project and --repository.\n',
      );
      continue;
    }
    const task = await input.client.createTask({
      title: defaultTaskTitle(line),
      request: line,
      projectId: project,
      repositoryId: repository,
      dryRun: input.options['dry-run'],
    });
    input.io.stdout.write(`${interactiveTaskHuman(task)}\n`);
  }
  return 0;
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
        model: { type: 'string' },
        'base-url': { type: 'string' },
        'api-key-env': { type: 'string' },
        'review-api-key-env': { type: 'string' },
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
    const options = parsed.values;
    const json = options.json;
    const quiet = options.quiet;
    const print = (value: unknown, human: string): void => {
      if (json) io.stdout.write(`${JSON.stringify(value)}\n`);
      else if (!quiet) io.stdout.write(`${human}\n`);
    };
    let [command, action, argument, ...extra] = parsed.positionals;
    if (
      !command &&
      !options.help &&
      !options.version &&
      !options.json &&
      !options['non-interactive'] &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    ) {
      command = 'chat';
    }
    if (command && lifecycleAliases.has(command)) {
      action = command;
      command = 'runtime';
    } else if (command === 'health') {
      command = 'doctor';
    } else if (command === 'interactive' || command === 'repl') {
      command = 'chat';
    } else if (command === 'tasks') {
      command = 'task';
      action = 'list';
    } else if (
      command === 'ask' ||
      command === 'command' ||
      command === 'cmd'
    ) {
      const request = requestText([action, argument, ...extra]);
      command = 'task';
      action = 'create';
      argument = undefined;
      extra = [];
      if (request && !options.request) options.request = request;
      if (request && !options.title) options.title = defaultTaskTitle(request);
    } else if (command === 'watch') {
      command = 'task';
      argument = action;
      action = 'watch';
      options.follow = true;
    } else if (command === 'output') {
      command = 'task';
      argument = action;
      action = 'logs';
      options.follow = true;
    } else if (command === 'shell') {
      command = 'task';
      argument = action;
      action = 'shell';
    }
    if (options.version) {
      print({ version: VERSION }, VERSION);
      return 0;
    }
    if (options.help || !command) {
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
      const endpoint = options.endpoint;
      const token = options.token;
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
        assertSupportedRuntimeNode();
        const child = (dependencies.spawnForeground ?? spawnForeground)(
          (dependencies.runtimeEntry ?? runtimeEntry)(),
          paths.pidFile,
        );
        return await child;
      }
      if (action === 'start' || action === 'restart') {
        assertSupportedRuntimeNode();
        const store = createStore();
        if (!store.save) throw new Error('Profile storage is unavailable');
        if (action === 'restart') {
          await (dependencies.stopRuntimeProcess ?? stopRuntimeProcess)(paths);
        }
        const context = await runtimeStartContext({ options, paths, store });
        const pid = await (
          dependencies.startRuntimeProcess ?? startRuntimeProcess
        )({
          paths,
          entry: (dependencies.runtimeEntry ?? runtimeEntry)(),
          environment: context.environment,
        });
        await store.save(
          context.profile,
          {
            endpoint: context.endpoint,
            token: context.token,
            allowInsecureRemote: false,
          },
          true,
        );
        const started = {
          running: true,
          pid,
          profile: context.profile,
          endpoint: context.endpoint,
          model: context.model ?? null,
        };
        const startedHuman = `Praxrail engine ${
          action === 'restart' ? 'restarted' : 'started'
        } as PID ${pid}${context.model ? ` using ${context.model}` : ''}`;
        print(started, startedHuman);
        const shouldOpenInteractive =
          !json &&
          !quiet &&
          !options['non-interactive'] &&
          (dependencies.interactiveLines !== undefined ||
            (process.stdin.isTTY && process.stdout.isTTY));
        if (!shouldOpenInteractive) return 0;
        const timeoutMs = timeoutValue(options.timeout);
        const createClient =
          dependencies.createClient ??
          ((clientOptions: PraxrailClientOptions) =>
            new PraxrailClient(clientOptions));
        const client = createClient({
          endpoint: context.endpoint,
          token: context.token,
          allowInsecureRemote: false,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }) as PraxrailClient;
        return await runInteractiveSession({
          client,
          io,
          options,
          lines: dependencies.interactiveLines,
        });
      }
      if (action === 'stop') {
        const stopped = await (
          dependencies.stopRuntimeProcess ?? stopRuntimeProcess
        )(paths);
        print(
          { running: false, stopped },
          stopped
            ? 'Praxrail engine stopped'
            : 'Praxrail engine is not running',
        );
        return 0;
      }
      if (action === 'status') {
        const pid = await (dependencies.runtimePid ?? runtimePid)(paths);
        if (!pid) {
          print({ running: false }, 'Praxrail engine is not running');
          return 3;
        }
        const store = (
          dependencies.createProfileStore ?? (() => new ProfileStore())
        )();
        const profile = await store.get(options.profile).catch(() => null);
        if (!profile) {
          print(
            { running: true, pid },
            `Praxrail engine is running as PID ${pid}`,
          );
          return 0;
        }
        const createClient =
          dependencies.createClient ??
          ((clientOptions: PraxrailClientOptions) =>
            new PraxrailClient(clientOptions));
        const timeoutMs = timeoutValue(options.timeout);
        const client = createClient({
          ...profile,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        const status = await client.runtimeStatus();
        print(
          { running: true, pid, status },
          `Praxrail engine ${status.status.toLowerCase()} as PID ${pid}`,
        );
        return status.status === 'READY' ? 0 : 4;
      }
      if (action === 'logs') {
        const content = await (dependencies.readRuntimeLog ?? readRuntimeLog)(
          paths,
        );
        print({ content }, content || 'No engine logs available');
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
    if (command === 'chat') {
      if (json) {
        throw new CliUsageError('Interactive mode does not support --json');
      }
      const store = createStore();
      const profile = await store.get(options.profile);
      const timeoutMs = timeoutValue(options.timeout);
      const createClient =
        dependencies.createClient ??
        ((options: PraxrailClientOptions) => new PraxrailClient(options));
      const client = createClient({
        ...profile,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }) as PraxrailClient;
      return await runInteractiveSession({
        client,
        io,
        options,
        lines: dependencies.interactiveLines,
      });
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
      throw new CliUsageError('Unknown command. Run pxr --help.');
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
    const profile = await store.get(options.profile);
    const timeoutMs = timeoutValue(options.timeout);
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
      options,
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
    throw new CliUsageError('Unknown command. Run pxr --help.');
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
