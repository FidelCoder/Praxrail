import { z } from 'zod';

export const verificationLayerSchema = z.enum([
  'FORMAT',
  'LINT',
  'STATIC_ANALYSIS',
  'TYPECHECK',
  'UNIT_TEST',
  'INTEGRATION_TEST',
  'BUILD',
  'TASK',
]);
export type VerificationLayer = z.infer<typeof verificationLayerSchema>;

export const repositoryCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    layer: verificationLayerSchema,
    executable: z
      .string()
      .regex(/^[a-zA-Z0-9._+-]+$/)
      .max(100),
    args: z.array(z.string().max(500)).max(50),
    required: z.boolean().default(true),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(30 * 60_000),
  })
  .strict();
export type RepositoryCommand = z.infer<typeof repositoryCommandSchema>;

export const repositoryPolicySchema = z
  .object({
    version: z.literal(1),
    fullName: z
      .string()
      .regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/)
      .transform((value) => value.toLowerCase()),
    cloneUrl: z.url(),
    defaultBranch: z
      .string()
      .regex(/^[a-zA-Z0-9._/-]+$/)
      .max(250),
    installationId: z.number().int().positive(),
    workerProfile: z.enum(['frontend', 'backend', 'general']),
    container: z.object({
      image: z.string().regex(/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/i),
      cpus: z.number().positive().max(8),
      memoryMb: z.number().int().min(128).max(16_384),
      processLimit: z.number().int().min(16).max(4_096),
    }),
    writeConcurrency: z.literal(1),
    commands: z.array(repositoryCommandSchema).min(5).max(30),
    submodules: z.enum(['DENY', 'ALLOWLIST']).default('DENY'),
    allowedSubmodules: z.array(z.url()).max(20).default([]),
    networkPolicy: z.enum(['NONE', 'PACKAGE_INSTALL_ONLY']).default('NONE'),
    riskOverrides: z.record(
      z.string().max(100),
      z.enum(['LOW', 'MEDIUM', 'HIGH']),
    ),
  })
  .strict()
  .superRefine((policy, context) => {
    const required = new Set(
      policy.commands
        .filter((command) => command.required)
        .map((command) => command.layer),
    );
    for (const layer of [
      'FORMAT',
      'LINT',
      'TYPECHECK',
      'UNIT_TEST',
      'BUILD',
    ] as const) {
      if (!required.has(layer)) {
        context.addIssue({
          code: 'custom',
          path: ['commands'],
          message: `Required verification layer ${layer} is missing`,
        });
      }
    }
    if (policy.submodules === 'DENY' && policy.allowedSubmodules.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['allowedSubmodules'],
        message: 'Allowed submodules require ALLOWLIST policy',
      });
    }
    const identity = canonicalRepositoryIdentity(policy.cloneUrl);
    if (identity !== policy.fullName) {
      context.addIssue({
        code: 'custom',
        path: ['cloneUrl'],
        message: 'Clone URL identity does not match fullName',
      });
    }
  });
export type RepositoryPolicy = z.infer<typeof repositoryPolicySchema>;

export function canonicalRepositoryIdentity(cloneUrl: string): string {
  const url = new URL(cloneUrl);
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Repository clone URL must be credential-free GitHub HTTPS',
    );
  }
  const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(path)) {
    throw new Error('Repository clone URL has an invalid identity');
  }
  return path.toLowerCase();
}

export function sanitizeGitSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'task';
}
