import { z } from 'zod';
import { actorRoleSchema } from './access.js';

export const API_VERSION = 'v1' as const;

export const apiErrorCodes = [
  'AUTHENTICATION_FAILED',
  'ACTION_NOT_PERMITTED',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
export const apiErrorCodeSchema = z.enum(apiErrorCodes);

export const apiErrorSchema = z
  .object({
    error: apiErrorCodeSchema,
    message: z.string().min(1).max(1_000),
    correlationId: z.string().min(1).max(200),
    retryable: z.boolean(),
  })
  .strict();
export type ApiError = z.infer<typeof apiErrorSchema>;

export const runtimeStatusSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    runtimeVersion: z.string().min(1).max(50),
    status: z.enum(['READY', 'DEGRADED']),
    database: z.boolean(),
    queue: z.boolean(),
    mode: z.enum(['LOCAL', 'REMOTE']),
  })
  .strict();
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

export const tokenRotationResponseSchema = z
  .object({
    token: z.string().min(32),
    actorId: z.string().min(1).max(200),
    role: actorRoleSchema,
  })
  .strict();
