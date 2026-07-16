import { z } from 'zod';

const taskReference = z
  .string()
  .regex(/^(?:PXR-\d+|[0-9a-f]{8}-[0-9a-f-]{27,})$/i);

export type TelegramCommand =
  | { kind: 'TASK'; text: string }
  | { kind: 'STATUS'; task?: string }
  | { kind: 'PAUSE'; task: string }
  | { kind: 'RESUME'; task: string }
  | { kind: 'PRIORITY'; task: string; priority: number }
  | { kind: 'APPROVE'; approvalId: string; token: string; reason: string }
  | { kind: 'REJECT'; approvalId: string; token: string; reason: string }
  | { kind: 'BUDGET'; task?: string }
  | { kind: 'NATURAL_LANGUAGE'; text: string };

export function parseTelegramCommand(text: string): TelegramCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/'))
    return { kind: 'NATURAL_LANGUAGE', text: trimmed };

  const [rawCommand, ...parts] = trimmed.split(/\s+/);
  const command = rawCommand?.split('@', 1)[0]?.toLowerCase();
  switch (command) {
    case '/task': {
      const taskText = parts.join(' ').trim();
      if (taskText.length < 5)
        throw new Error('/task requires a meaningful description');
      return { kind: 'TASK', text: taskText };
    }
    case '/status': {
      const task = parts[0];
      return task
        ? { kind: 'STATUS', task: taskReference.parse(task) }
        : { kind: 'STATUS' };
    }
    case '/pause':
      return { kind: 'PAUSE', task: taskReference.parse(parts[0]) };
    case '/resume':
      return { kind: 'RESUME', task: taskReference.parse(parts[0]) };
    case '/priority': {
      const task = taskReference.parse(parts[0]);
      const priority = z.coerce.number().int().min(0).max(100).parse(parts[1]);
      return { kind: 'PRIORITY', task, priority };
    }
    case '/approve':
    case '/reject': {
      const approvalId = z.uuid().parse(parts[0]);
      const token = z.string().min(32).parse(parts[1]);
      const reason =
        parts.slice(2).join(' ').trim() ||
        (command === '/approve' ? 'Approved' : 'Rejected');
      return command === '/approve'
        ? { kind: 'APPROVE', approvalId, token, reason }
        : { kind: 'REJECT', approvalId, token, reason };
    }
    case '/budget': {
      const task = parts[0];
      return task
        ? { kind: 'BUDGET', task: taskReference.parse(task) }
        : { kind: 'BUDGET' };
    }
    default:
      throw new Error(`Unsupported command: ${command ?? 'unknown'}`);
  }
}
