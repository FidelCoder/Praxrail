import { z } from 'zod';

const telegramUserSchema = z.object({
  id: z.number().int().positive(),
  is_bot: z.boolean().optional(),
  first_name: z.string().max(128).optional(),
  username: z.string().max(64).optional(),
});

const telegramChatSchema = z.object({
  id: z.number().int(),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
});

const telegramMessageSchema = z.object({
  message_id: z.number().int().nonnegative(),
  date: z.number().int().nonnegative(),
  from: telegramUserSchema.optional(),
  chat: telegramChatSchema,
  text: z.string().max(10_000).optional(),
});

const callbackQuerySchema = z.object({
  id: z.string().min(1).max(256),
  from: telegramUserSchema,
  message: telegramMessageSchema.optional(),
  data: z.string().max(512).optional(),
});

export const telegramUpdateSchema = z
  .object({
    update_id: z.number().int().nonnegative(),
    message: telegramMessageSchema.optional(),
    callback_query: callbackQuerySchema.optional(),
  })
  .refine((value) => Boolean(value.message ?? value.callback_query), {
    message: 'Unsupported Telegram update type',
  });

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export interface TelegramEnvelope {
  updateId: number;
  userId: number;
  chatId: number;
  text: string;
  externalMessageId: string;
  raw: TelegramUpdate;
}

export function normalizeTelegramUpdate(input: unknown): TelegramEnvelope {
  const update = telegramUpdateSchema.parse(input);
  if (update.message) {
    if (!update.message.from || !update.message.text) {
      throw new Error('Telegram message must have a sender and text');
    }
    return {
      updateId: update.update_id,
      userId: update.message.from.id,
      chatId: update.message.chat.id,
      text: update.message.text,
      externalMessageId: String(update.update_id),
      raw: update,
    };
  }

  const callback = update.callback_query;
  if (!callback?.message || !callback.data) {
    throw new Error('Telegram callback must have message context and data');
  }
  return {
    updateId: update.update_id,
    userId: callback.from.id,
    chatId: callback.message.chat.id,
    text: callback.data,
    externalMessageId: String(update.update_id),
    raw: update,
  };
}
