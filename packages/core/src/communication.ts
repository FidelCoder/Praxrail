import { z } from 'zod';

export const communicationChannels = ['EMAIL', 'TELEGRAM'] as const;
export const communicationChannelSchema = z.enum(communicationChannels);

export const remoteActions = [
  'TASK_CREATE',
  'CLARIFY',
  'APPROVE',
  'REJECT',
  'PAUSE',
  'RESUME',
  'STATUS',
] as const;
export const remoteActionSchema = z.enum(remoteActions);
export type RemoteAction = z.infer<typeof remoteActionSchema>;

export const notificationEventSchema = z
  .object({
    version: z.literal(1),
    eventId: z.uuid(),
    taskId: z.uuid().nullable(),
    projectId: z.uuid().nullable(),
    type: z.string().min(1).max(100),
    severity: z.enum(['INFO', 'ACTION_REQUIRED', 'WARNING', 'CRITICAL']),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(2_000),
    action: remoteActionSchema.nullable(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();
export type NotificationEvent = z.infer<typeof notificationEventSchema>;
