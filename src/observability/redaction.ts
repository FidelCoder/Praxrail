const sensitiveKey =
  /(?:authorization|token|secret|password|private[_-]?key|cookie)/i;

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value))
    return value.map((entry) => redactSensitive(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sensitiveKey.test(key)
          ? '[REDACTED]'
          : redactSensitive(entry, depth + 1),
      ]),
    );
  }
  return value;
}

export const loggerRedactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.x-telegram-bot-api-secret-token',
  'req.params.secret',
  'config.telegram.botToken',
  'config.telegram.webhookSecret',
  'config.github.privateKey',
  'config.github.webhookSecret',
  '*.token',
  '*.secret',
  '*.password',
];
