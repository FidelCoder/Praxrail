import { timingSafeEqual } from 'node:crypto';
import { AuthenticationError } from '../../domain/errors.js';

function secretsMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function authenticateTelegram(input: {
  configuredSecret: string;
  pathSecret: string;
  headerSecret?: string;
  userId: number;
  chatId: number;
  allowedUserIds: ReadonlySet<number>;
  allowedChatIds: ReadonlySet<number>;
}): void {
  if (!secretsMatch(input.pathSecret, input.configuredSecret)) {
    throw new AuthenticationError();
  }
  if (
    input.headerSecret &&
    !secretsMatch(input.headerSecret, input.configuredSecret)
  ) {
    throw new AuthenticationError();
  }
  if (
    !input.allowedUserIds.has(input.userId) ||
    !input.allowedChatIds.has(input.chatId)
  ) {
    throw new AuthenticationError();
  }
}
