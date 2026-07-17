import { z } from 'zod';

export const TASK_STATUSES = [
  'INBOX',
  'REFINING',
  'BLOCKED',
  'READY',
  'BUILDING',
  'FAILED',
  'REVIEWING',
  'CHANGES_REQUESTED',
  'CI',
  'PR_READY',
  'AWAITING_APPROVAL',
  'MERGED',
  'DEPLOYED',
  'VERIFIED',
  'CANCELLED',
  'ABANDONED',
  'SUPERSEDED',
] as const;

export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSummarySchema = z
  .object({
    id: z.uuid(),
    taskKey: z.string().min(1).max(32),
    title: z.string().min(1).max(180),
    status: taskStatusSchema,
    priority: z.number().int().min(0).max(100),
    paused: z.boolean(),
    budgetUsd: z.number().nonnegative().nullable(),
  })
  .strict();
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const taskEventSchema = z
  .object({
    id: z.number().int().positive(),
    taskId: z.uuid(),
    eventType: z.string().min(1).max(100),
    actorType: z.string().min(1).max(100),
    actorId: z.string().min(1).max(200),
    correlationId: z.uuid(),
    payload: z.record(z.string(), z.unknown()),
    occurredAt: z.iso.datetime(),
  })
  .strict();
export type TaskEvent = z.infer<typeof taskEventSchema>;

export const taskOutputChunkSchema = z
  .object({
    id: z.number().int().positive(),
    taskId: z.uuid(),
    attemptId: z.uuid().nullable(),
    stream: z.enum(['STDOUT', 'STDERR', 'SYSTEM']),
    content: z.string().max(32_768),
    truncated: z.boolean(),
    occurredAt: z.iso.datetime(),
  })
  .strict();
export type TaskOutputChunk = z.infer<typeof taskOutputChunkSchema>;
