import { z } from 'zod';

export const workerModeSchema = z.enum(['EMBEDDED', 'REMOTE']);
export const workerStatusSchema = z.enum([
  'ACTIVE',
  'DRAINING',
  'OFFLINE',
  'REVOKED',
]);

export const workerRegistrationSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    mode: workerModeSchema,
    version: z.string().trim().min(1).max(50),
    profiles: z
      .array(z.string().regex(/^[a-z0-9]+(?:[ -][a-z0-9]+)*$/))
      .min(1)
      .max(50),
    repositoryIds: z.array(z.uuid()).min(1).max(500),
    capabilities: z.array(z.string().min(1).max(100)).max(100).default([]),
    leaseMilliseconds: z.number().int().min(5_000).max(300_000).default(60_000),
  })
  .strict();
export type WorkerRegistrationInput = z.input<typeof workerRegistrationSchema>;
export type WorkerRegistration = z.output<typeof workerRegistrationSchema>;

export const workerSchema = workerRegistrationSchema
  .omit({ leaseMilliseconds: true })
  .extend({
    id: z.uuid(),
    status: workerStatusSchema,
    fencingToken: z.string().regex(/^\d+$/),
    leaseExpiresAt: z.iso.datetime(),
  })
  .strict();
export type Worker = z.infer<typeof workerSchema>;

export const workerHeartbeatSchema = z
  .object({
    fencingToken: z.string().regex(/^\d+$/),
    leaseMilliseconds: z.number().int().min(5_000).max(300_000).default(60_000),
  })
  .strict();

export const workerClaimSchema = z
  .object({
    fencingToken: z.string().regex(/^\d+$/),
    leaseMilliseconds: z.number().int().min(5_000).max(300_000).default(60_000),
  })
  .strict();

export const workerAssignmentSchema = z
  .object({
    id: z.uuid(),
    workerId: z.uuid(),
    taskId: z.uuid(),
    taskKey: z.string().min(1).max(32),
    repositoryId: z.uuid(),
    repositoryFullName: z.string().min(3).max(300),
    workerProfile: z.string().min(2).max(64),
    attemptId: z.uuid(),
    attemptNumber: z.number().int().positive(),
    fencingToken: z.string().regex(/^\d+$/),
    leaseExpiresAt: z.iso.datetime(),
  })
  .strict();
export type WorkerAssignment = z.infer<typeof workerAssignmentSchema>;
