import { describe, expect, it } from 'vitest';
import { AuthenticationError } from '../src/domain/errors.js';
import { authenticateTelegram } from '../src/integrations/telegram/auth.js';
import { parseTelegramCommand } from '../src/integrations/telegram/commands.js';
import { SenderRateLimiter } from '../src/integrations/telegram/rate-limiter.js';
import { normalizeTelegramUpdate } from '../src/integrations/telegram/schema.js';

describe('Telegram intake', () => {
  const auth = {
    configuredSecret: 'a-secure-telegram-secret',
    pathSecret: 'a-secure-telegram-secret',
    headerSecret: 'a-secure-telegram-secret',
    userId: 123,
    chatId: 456,
    allowedUserIds: new Set([123]),
    allowedChatIds: new Set([456]),
  };

  it('normalizes supported text and callback updates', () => {
    const message = normalizeTelegramUpdate({
      update_id: 7,
      message: {
        message_id: 4,
        date: 1_784_200_000,
        from: { id: 123, first_name: 'Owner' },
        chat: { id: 456, type: 'private' },
        text: '/status PXR-0001',
      },
    });
    expect(message.externalMessageId).toBe('7');
    expect(message.text).toBe('/status PXR-0001');

    const callback = normalizeTelegramUpdate({
      update_id: 8,
      callback_query: {
        id: 'callback-1',
        from: { id: 123, first_name: 'Owner' },
        data: '/approve 11111111-1111-4111-8111-111111111111 abcdefghijklmnopqrstuvwxyz123456',
        message: {
          message_id: 5,
          date: 1_784_200_001,
          chat: { id: 456, type: 'private' },
        },
      },
    });
    expect(callback.userId).toBe(123);
  });

  it('requires the configured secret and both allowlists', () => {
    expect(() => authenticateTelegram(auth)).not.toThrow();
    expect(() =>
      authenticateTelegram({ ...auth, pathSecret: 'incorrect-secret-value' }),
    ).toThrow(AuthenticationError);
    expect(() =>
      authenticateTelegram({ ...auth, allowedUserIds: new Set() }),
    ).toThrow(AuthenticationError);
    expect(() =>
      authenticateTelegram({ ...auth, allowedChatIds: new Set() }),
    ).toThrow(AuthenticationError);
  });

  it('parses deterministic commands before natural language', () => {
    expect(parseTelegramCommand('/task Fix frontend login validation')).toEqual(
      {
        kind: 'TASK',
        text: 'Fix frontend login validation',
      },
    );
    expect(parseTelegramCommand('/priority PXR-42 90')).toEqual({
      kind: 'PRIORITY',
      task: 'PXR-42',
      priority: 90,
    });
    expect(parseTelegramCommand('Add a backend test')).toEqual({
      kind: 'NATURAL_LANGUAGE',
      text: 'Add a backend test',
    });
    expect(() => parseTelegramCommand('/priority PXR-42 101')).toThrow();
    expect(() => parseTelegramCommand('/unknown')).toThrow(/Unsupported/);
  });

  it('rate limits each sender independently within a window', () => {
    const limiter = new SenderRateLimiter(2, 1_000);
    expect(limiter.allow(1, 1_000)).toBe(true);
    expect(limiter.allow(1, 1_100)).toBe(true);
    expect(limiter.allow(1, 1_200)).toBe(false);
    expect(limiter.allow(2, 1_200)).toBe(true);
    expect(limiter.allow(1, 2_101)).toBe(true);
  });
});
