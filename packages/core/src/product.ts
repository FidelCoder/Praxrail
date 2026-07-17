import { z } from 'zod';
import { actorRoleSchema } from './access.js';
import { taskStatusSchema } from './task.js';

export const projectStatusSchema = z.enum(['ACTIVE', 'PAUSED', 'DISABLED']);
export const projectSchema = z
  .object({
    id: z.uuid(),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    name: z.string().min(2).max(120),
    status: projectStatusSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;

export const repositoryStatusSchema = z.enum([
  'PENDING',
  'BLOCKED',
  'APPROVED',
  'DISABLED',
]);
export const repositorySchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    fullName: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
    cloneUrl: z.url(),
    defaultBranch: z.string().min(1).max(200),
    workerProfile: z.string().min(1).max(100),
    status: repositoryStatusSchema,
    enabled: z.boolean(),
    inspection: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type Repository = z.infer<typeof repositorySchema>;

export const taskDetailSchema = z
  .object({
    id: z.uuid(),
    taskKey: z.string().min(1).max(32),
    projectId: z.uuid().nullable(),
    repositoryId: z.uuid().nullable(),
    title: z.string().min(1).max(180),
    problem: z.string(),
    desiredOutcome: z.string(),
    status: taskStatusSchema,
    priority: z.number().int().min(0).max(100),
    risk: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable(),
    contract: z.record(z.string(), z.unknown()).nullable(),
    version: z.number().int().positive(),
    paused: z.boolean(),
    blockedReason: z.string().nullable(),
    budgetUsd: z.number().nonnegative().nullable(),
    spentUsd: z.number().nonnegative(),
    currentAttempt: z.number().int().nonnegative(),
    maximumAttempts: z.number().int().positive().nullable(),
    archivedAt: z.iso.datetime().nullable(),
    requiredAction: z.string().min(1).max(500),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const taskEvidenceSchema = z
  .object({
    taskId: z.uuid(),
    attempts: z.array(z.record(z.string(), z.unknown())),
    costs: z.array(z.record(z.string(), z.unknown())),
    verification: z.array(z.record(z.string(), z.unknown())),
    findings: z.array(z.record(z.string(), z.unknown())),
    review: z.array(z.record(z.string(), z.unknown())),
    pullRequest: z.record(z.string(), z.unknown()).nullable(),
    git: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type TaskEvidence = z.infer<typeof taskEvidenceSchema>;

export const diagnosticCheckSchema = z
  .object({
    name: z.string().min(1).max(100),
    status: z.enum(['PASS', 'WARN', 'FAIL']),
    message: z.string().min(1).max(1_000),
    remediation: z.string().min(1).max(1_000).nullable(),
  })
  .strict();
export const diagnosticReportSchema = z
  .object({
    status: z.enum(['READY', 'DEGRADED', 'BLOCKED']),
    generatedAt: z.iso.datetime(),
    apiVersion: z.string().min(1),
    runtimeVersion: z.string().min(1),
    databaseVersion: z.string().min(1),
    minimumClientVersion: z.string().min(1),
    checks: z.array(diagnosticCheckSchema),
  })
  .strict();
export type DiagnosticReport = z.infer<typeof diagnosticReportSchema>;

export const channelSchema = z.enum(['EMAIL', 'TELEGRAM']);
export const channelIdentityStatusSchema = z.enum([
  'PENDING',
  'VERIFIED',
  'DISABLED',
  'REVOKED',
]);
export const channelIdentitySchema = z
  .object({
    id: z.uuid(),
    channel: channelSchema,
    projectId: z.uuid().nullable(),
    role: actorRoleSchema,
    destinationHint: z.string().min(1).max(200),
    status: channelIdentityStatusSchema,
    verifiedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type ChannelIdentity = z.infer<typeof channelIdentitySchema>;

export const channelPreferenceSchema = z
  .object({
    channel: channelSchema,
    projectId: z.uuid().nullable(),
    minimumSeverity: z.enum(['INFO', 'ACTION_REQUIRED', 'WARNING', 'CRITICAL']),
    deliveryMode: z.enum(['IMMEDIATE', 'DIGEST', 'MUTED']),
    quietHoursStart: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable(),
    quietHoursEnd: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable(),
    timezone: z.string().min(1).max(100),
    escalationMinutes: z.number().int().min(0).max(10_080).nullable(),
  })
  .strict();
export type ChannelPreference = z.infer<typeof channelPreferenceSchema>;

export const supportBundleSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.iso.datetime(),
    manifest: z.array(z.string().min(1)),
    runtime: z.record(z.string(), z.unknown()),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    recentFailures: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();
export type SupportBundle = z.infer<typeof supportBundleSchema>;
