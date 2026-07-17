import path from 'node:path';
import { readFileSync } from 'node:fs';
import { actorRoleSchema, type ActorRole } from 'praxrail-core';
import { z } from 'zod';

const booleanValue = z.preprocess((value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return value;
}, z.boolean());

const csvStrings = z.preprocess(
  (value: unknown): unknown => {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || value.trim() === '') return [];
    return value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  },
  z.array(z.string().min(1)),
);

const csvPositiveIntegers = z.preprocess((value: unknown): unknown => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(',').map((part) => part.trim());
}, z.array(z.coerce.number().int().positive()));

const optionalSecret = z.preprocess(
  (value: unknown): unknown => (value === '' ? undefined : value),
  z.string().min(16).optional(),
);

const optionalUrl = z.preprocess(
  (value: unknown): unknown => (value === '' ? undefined : value),
  z.url().optional(),
);

const secretFileMappings = [
  ['DATABASE_URL', 'DATABASE_URL_FILE'],
  ['MIGRATION_DATABASE_URL', 'MIGRATION_DATABASE_URL_FILE'],
  ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN_FILE'],
  ['TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_WEBHOOK_SECRET_FILE'],
  ['GITHUB_PRIVATE_KEY_BASE64', 'GITHUB_PRIVATE_KEY_BASE64_FILE'],
  ['GITHUB_WEBHOOK_SECRET', 'GITHUB_WEBHOOK_SECRET_FILE'],
  ['CODEX_BUILDER_API_KEY', 'CODEX_BUILDER_API_KEY_FILE'],
  ['CODEX_REVIEWER_API_KEY', 'CODEX_REVIEWER_API_KEY_FILE'],
  ['API_BOOTSTRAP_TOKEN', 'API_BOOTSTRAP_TOKEN_FILE'],
] as const;

function loadSecretFiles(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const loaded = { ...environment };
  for (const [valueName, fileName] of secretFileMappings) {
    if (loaded[valueName]) continue;
    const filename = loaded[fileName];
    if (!filename) continue;
    const value = readFileSync(filename, 'utf8').trim();
    if (!value) throw new Error(`${fileName} points to an empty secret file`);
    loaded[valueName] = value;
  }
  return loaded;
}

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    API_ENABLED: booleanValue.default(false),
    API_SOCKET_PATH: z.preprocess(
      (value: unknown): unknown => (value === '' ? undefined : value),
      z.string().min(1).max(1_000).optional(),
    ),
    API_BOOTSTRAP_TOKEN: z.preprocess(
      (value: unknown): unknown => (value === '' ? undefined : value),
      z.string().min(32).optional(),
    ),
    API_BOOTSTRAP_ACTOR_ID: z.string().min(1).max(200).default('local-owner'),
    API_BOOTSTRAP_ROLE: actorRoleSchema.default('OWNER'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.url(),
    MIGRATION_DATABASE_URL: optionalUrl,
    DATABASE_SSL: booleanValue.default(false),
    MIGRATIONS_DIR: z.string().default('./migrations'),
    OWNER_TIMEZONE: z.string().min(1).default('Africa/Nairobi'),
    DAILY_REPORT_TIME: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .default('18:00'),
    TASK_BUDGET_USD: z.coerce.number().positive().default(5),
    DAILY_BUDGET_USD: z.coerce.number().positive().default(25),
    MONTHLY_BUDGET_USD: z.coerce.number().positive().default(300),
    MAX_BUILD_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    MAX_REVIEW_CYCLES: z.coerce.number().int().min(1).max(10).default(2),
    JOB_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    JOB_RETRY_LIMIT: z.coerce.number().int().min(0).max(10).default(3),
    JOB_RETRY_DELAY_SECONDS: z.coerce.number().int().min(1).max(300).default(5),
    WORKSPACE_ROOT: z.string().default('./.praxrail/workspaces'),
    REPOSITORY_ROOT: z.string().default('./.praxrail/repositories'),
    TELEGRAM_ENABLED: booleanValue.default(false),
    TELEGRAM_BOT_TOKEN: optionalSecret,
    TELEGRAM_WEBHOOK_SECRET: optionalSecret,
    TELEGRAM_ALLOWED_USER_IDS: csvPositiveIntegers.default([]),
    TELEGRAM_ALLOWED_CHAT_IDS: csvPositiveIntegers.default([]),
    GITHUB_ENABLED: booleanValue.default(false),
    GITHUB_APP_ID: z.preprocess(
      (value: unknown): unknown => (value === '' ? undefined : value),
      z.coerce.number().int().positive().optional(),
    ),
    GITHUB_PRIVATE_KEY_BASE64: optionalSecret,
    GITHUB_WEBHOOK_SECRET: optionalSecret,
    GITHUB_ALLOWED_REPOSITORIES: csvStrings.default([]),
    CODEX_ENABLED: booleanValue.default(false),
    CODEX_BUILDER_API_KEY: optionalSecret,
    CODEX_REVIEWER_API_KEY: optionalSecret,
    CODEX_MODEL: z.preprocess(
      (value: unknown): unknown => (value === '' ? undefined : value),
      z.string().min(1).max(100).optional(),
    ),
    CODEX_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(60 * 60_000)
      .default(20 * 60_000),
    OTEL_ENABLED: booleanValue.default(false),
    OTEL_SERVICE_NAME: z.string().min(1).default('praxrail'),
  })
  .superRefine((value, context) => {
    if (value.API_ENABLED && !value.API_BOOTSTRAP_TOKEN) {
      context.addIssue({
        code: 'custom',
        message:
          'API_BOOTSTRAP_TOKEN is required when the product API is enabled',
        path: ['API_BOOTSTRAP_TOKEN'],
      });
    }
    if (value.TELEGRAM_ENABLED) {
      for (const [field, valid] of [
        ['TELEGRAM_BOT_TOKEN', Boolean(value.TELEGRAM_BOT_TOKEN)],
        ['TELEGRAM_WEBHOOK_SECRET', Boolean(value.TELEGRAM_WEBHOOK_SECRET)],
        [
          'TELEGRAM_ALLOWED_USER_IDS',
          value.TELEGRAM_ALLOWED_USER_IDS.length > 0,
        ],
        [
          'TELEGRAM_ALLOWED_CHAT_IDS',
          value.TELEGRAM_ALLOWED_CHAT_IDS.length > 0,
        ],
      ] as const) {
        if (!valid) {
          context.addIssue({
            code: 'custom',
            message: `${field} is required when Telegram is enabled`,
            path: [field],
          });
        }
      }
    }

    if (value.GITHUB_ENABLED) {
      for (const [field, valid] of [
        ['GITHUB_APP_ID', Boolean(value.GITHUB_APP_ID)],
        ['GITHUB_PRIVATE_KEY_BASE64', Boolean(value.GITHUB_PRIVATE_KEY_BASE64)],
        ['GITHUB_WEBHOOK_SECRET', Boolean(value.GITHUB_WEBHOOK_SECRET)],
        [
          'GITHUB_ALLOWED_REPOSITORIES',
          value.GITHUB_ALLOWED_REPOSITORIES.length > 0,
        ],
      ] as const) {
        if (!valid) {
          context.addIssue({
            code: 'custom',
            message: `${field} is required when GitHub is enabled`,
            path: [field],
          });
        }
      }
    }

    if (value.CODEX_ENABLED) {
      for (const [field, valid] of [
        ['CODEX_BUILDER_API_KEY', Boolean(value.CODEX_BUILDER_API_KEY)],
        ['CODEX_REVIEWER_API_KEY', Boolean(value.CODEX_REVIEWER_API_KEY)],
        ['CODEX_MODEL', Boolean(value.CODEX_MODEL)],
      ] as const) {
        if (!valid) {
          context.addIssue({
            code: 'custom',
            message: `${field} is required when Codex is enabled`,
            path: [field],
          });
        }
      }
      if (
        value.CODEX_BUILDER_API_KEY &&
        value.CODEX_BUILDER_API_KEY === value.CODEX_REVIEWER_API_KEY
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Builder and reviewer Codex credentials must be distinct',
          path: ['CODEX_REVIEWER_API_KEY'],
        });
      }
    }

    if (value.DAILY_BUDGET_USD > value.MONTHLY_BUDGET_USD) {
      context.addIssue({
        code: 'custom',
        message: 'Daily budget cannot exceed monthly budget',
        path: ['DAILY_BUDGET_USD'],
      });
    }
    if (value.TASK_BUDGET_USD > value.DAILY_BUDGET_USD) {
      context.addIssue({
        code: 'custom',
        message: 'Task budget cannot exceed daily budget',
        path: ['TASK_BUDGET_USD'],
      });
    }
  });

export interface AppConfig {
  environment: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  api: {
    enabled: boolean;
    socketPath?: string;
    bootstrapToken?: string;
    bootstrapActorId: string;
    bootstrapRole: ActorRole;
  };
  database: {
    url: string;
    migrationUrl?: string;
    ssl: boolean;
    migrationsDir: string;
  };
  owner: { timezone: string; dailyReportTime: string };
  budget: { taskUsd: number; dailyUsd: number; monthlyUsd: number };
  attempts: { build: number; review: number };
  jobs: { concurrency: number; retryLimit: number; retryDelaySeconds: number };
  paths: { workspaceRoot: string; repositoryRoot: string };
  telegram: {
    enabled: boolean;
    botToken?: string;
    webhookSecret?: string;
    allowedUserIds: ReadonlySet<number>;
    allowedChatIds: ReadonlySet<number>;
  };
  github: {
    enabled: boolean;
    appId?: number;
    privateKey?: string;
    webhookSecret?: string;
    allowedRepositories: ReadonlySet<string>;
  };
  codex: {
    enabled: boolean;
    builderApiKey?: string;
    reviewerApiKey?: string;
    model?: string;
    timeoutMs: number;
  };
  telemetry: { enabled: boolean; serviceName: string };
}

function safeRoot(root: string, label: string): string {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`${label} cannot be the filesystem root`);
  }
  return resolved;
}

function decodePrivateKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (!decoded.includes('PRIVATE KEY')) {
    throw new Error(
      'GITHUB_PRIVATE_KEY_BASE64 is not a base64-encoded private key',
    );
  }
  return decoded;
}

function preventSecretSerialization<T extends object>(value: T): T {
  Object.defineProperty(value, 'toJSON', {
    enumerable: false,
    value: () => '[REDACTED]',
  });
  return value;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): AppConfig {
  const value = environmentSchema.parse(loadSecretFiles(environment));
  const resolveFromWorkingDirectory = (input: string): string =>
    path.resolve(workingDirectory, input);
  const githubPrivateKey = decodePrivateKey(value.GITHUB_PRIVATE_KEY_BASE64);

  const config: AppConfig = {
    environment: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    api: preventSecretSerialization({
      enabled: value.API_ENABLED,
      ...(value.API_SOCKET_PATH
        ? {
            socketPath: safeRoot(
              resolveFromWorkingDirectory(value.API_SOCKET_PATH),
              'API_SOCKET_PATH',
            ),
          }
        : {}),
      ...(value.API_BOOTSTRAP_TOKEN
        ? { bootstrapToken: value.API_BOOTSTRAP_TOKEN }
        : {}),
      bootstrapActorId: value.API_BOOTSTRAP_ACTOR_ID,
      bootstrapRole: value.API_BOOTSTRAP_ROLE,
    }),
    database: {
      url: value.DATABASE_URL,
      ...(value.MIGRATION_DATABASE_URL
        ? { migrationUrl: value.MIGRATION_DATABASE_URL }
        : {}),
      ssl: value.DATABASE_SSL,
      migrationsDir: resolveFromWorkingDirectory(value.MIGRATIONS_DIR),
    },
    owner: {
      timezone: value.OWNER_TIMEZONE,
      dailyReportTime: value.DAILY_REPORT_TIME,
    },
    budget: {
      taskUsd: value.TASK_BUDGET_USD,
      dailyUsd: value.DAILY_BUDGET_USD,
      monthlyUsd: value.MONTHLY_BUDGET_USD,
    },
    attempts: {
      build: value.MAX_BUILD_ATTEMPTS,
      review: value.MAX_REVIEW_CYCLES,
    },
    jobs: {
      concurrency: value.JOB_CONCURRENCY,
      retryLimit: value.JOB_RETRY_LIMIT,
      retryDelaySeconds: value.JOB_RETRY_DELAY_SECONDS,
    },
    paths: {
      workspaceRoot: safeRoot(
        resolveFromWorkingDirectory(value.WORKSPACE_ROOT),
        'WORKSPACE_ROOT',
      ),
      repositoryRoot: safeRoot(
        resolveFromWorkingDirectory(value.REPOSITORY_ROOT),
        'REPOSITORY_ROOT',
      ),
    },
    telegram: {
      enabled: value.TELEGRAM_ENABLED,
      ...(value.TELEGRAM_BOT_TOKEN
        ? { botToken: value.TELEGRAM_BOT_TOKEN }
        : {}),
      ...(value.TELEGRAM_WEBHOOK_SECRET
        ? { webhookSecret: value.TELEGRAM_WEBHOOK_SECRET }
        : {}),
      allowedUserIds: new Set(value.TELEGRAM_ALLOWED_USER_IDS),
      allowedChatIds: new Set(value.TELEGRAM_ALLOWED_CHAT_IDS),
    },
    github: {
      enabled: value.GITHUB_ENABLED,
      ...(value.GITHUB_APP_ID ? { appId: value.GITHUB_APP_ID } : {}),
      ...(githubPrivateKey ? { privateKey: githubPrivateKey } : {}),
      ...(value.GITHUB_WEBHOOK_SECRET
        ? { webhookSecret: value.GITHUB_WEBHOOK_SECRET }
        : {}),
      allowedRepositories: new Set(
        value.GITHUB_ALLOWED_REPOSITORIES.map((repository) =>
          repository.toLowerCase(),
        ),
      ),
    },
    codex: {
      enabled: value.CODEX_ENABLED,
      ...(value.CODEX_BUILDER_API_KEY
        ? { builderApiKey: value.CODEX_BUILDER_API_KEY }
        : {}),
      ...(value.CODEX_REVIEWER_API_KEY
        ? { reviewerApiKey: value.CODEX_REVIEWER_API_KEY }
        : {}),
      ...(value.CODEX_MODEL ? { model: value.CODEX_MODEL } : {}),
      timeoutMs: value.CODEX_TIMEOUT_MS,
    },
    telemetry: {
      enabled: value.OTEL_ENABLED,
      serviceName: value.OTEL_SERVICE_NAME,
    },
  };
  preventSecretSerialization(config.database);
  preventSecretSerialization(config.telegram);
  preventSecretSerialization(config.github);
  preventSecretSerialization(config.codex);
  return preventSecretSerialization(config);
}
