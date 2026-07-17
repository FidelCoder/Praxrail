import { describe, expect, it } from 'vitest';
import { redactSensitive, redactText } from '../src/observability/redaction.js';

describe('log redaction', () => {
  it('redacts sensitive keys recursively while retaining diagnostic fields', () => {
    const result = redactSensitive({
      taskId: 'task-1',
      authorization: 'Bearer secret',
      nested: { privateKey: 'pem', password: 'pw', status: 'failed' },
      entries: [{ token: 'abc', code: 'AUTH_FAILED' }],
    });
    expect(result).toEqual({
      taskId: 'task-1',
      authorization: '[REDACTED]',
      nested: {
        privateKey: '[REDACTED]',
        password: '[REDACTED]',
        status: 'failed',
      },
      entries: [{ token: '[REDACTED]', code: 'AUTH_FAILED' }],
    });
  });

  it('redacts bearer and Praxrail tokens from streamed text', () => {
    expect(
      redactText(
        `Authorization: Bearer secret-value pxr_${'a'.repeat(40)} password=hunter2`,
      ),
    ).not.toMatch(/secret-value|pxr_|hunter2/);
  });
});
