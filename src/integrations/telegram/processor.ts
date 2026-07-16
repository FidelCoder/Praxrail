import { randomUUID } from 'node:crypto';
import type { DurableQueue } from '../../jobs/queue.js';
import type { IncomingMessageService } from '../../services/incoming-message-service.js';
import type { TaskService } from '../../services/task-service.js';
import { parseTelegramCommand } from './commands.js';
import type { TelegramCommandService } from './command-service.js';
import type { TelegramEnvelope } from './schema.js';

export interface TelegramProcessingResult {
  replayed: boolean;
  message: string;
  taskId?: string;
}

export class TelegramProcessor {
  constructor(
    private readonly tasks: TaskService,
    private readonly incomingMessages: IncomingMessageService,
    private readonly commands: TelegramCommandService,
    private readonly queue: DurableQueue,
  ) {}

  async reject(envelope: TelegramEnvelope): Promise<void> {
    await this.incomingMessages.record({
      provider: 'TELEGRAM',
      externalId: `rejected:${envelope.externalMessageId}`,
      senderId: String(envelope.userId),
      chatOrThreadId: String(envelope.chatId),
      envelope: envelope.raw,
      body: envelope.text,
      correlationId: randomUUID(),
      authenticated: false,
    });
  }

  async process(envelope: TelegramEnvelope): Promise<TelegramProcessingResult> {
    const command = parseTelegramCommand(envelope.text);
    const correlationId = randomUUID();
    if (command.kind === 'TASK' || command.kind === 'NATURAL_LANGUAGE') {
      const text = command.text;
      const created = await this.tasks.createInboxTask({
        provider: 'TELEGRAM',
        externalMessageId: envelope.externalMessageId,
        senderId: String(envelope.userId),
        chatOrThreadId: String(envelope.chatId),
        authenticated: true,
        envelope: envelope.raw,
        messageText: text,
        title: text.replace(/\s+/g, ' ').trim().slice(0, 180),
        actorType: 'OWNER',
        actorId: String(envelope.userId),
        correlationId,
      });
      await this.queue.send(
        'planning',
        { taskId: created.task.id, text, correlationId },
        { idempotencyKey: `planning:${created.task.id}` },
      );
      return {
        replayed: created.replayed,
        message: `${created.task.taskKey} ${created.replayed ? 'already accepted' : 'accepted'}.`,
        taskId: created.task.id,
      };
    }

    const recorded = await this.incomingMessages.record({
      provider: 'TELEGRAM',
      externalId: envelope.externalMessageId,
      senderId: String(envelope.userId),
      chatOrThreadId: String(envelope.chatId),
      envelope: envelope.raw,
      body: envelope.text,
      correlationId,
    });
    if (recorded.replayed)
      return { replayed: true, message: 'Command already processed.' };
    const result = await this.commands.execute(
      command,
      String(envelope.userId),
    );
    return { replayed: false, message: result.message };
  }
}
