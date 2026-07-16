import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGitHubSignature } from '../src/integrations/github/auth.js';
import {
  githubWebhookPayloadSchema,
  normalizeGitHubEvent,
} from '../src/integrations/github/schema.js';

describe('GitHub webhook handling', () => {
  it('accepts only the correct sha256 signature', () => {
    const secret = 'a-secure-github-webhook-secret';
    const body = Buffer.from('{"action":"opened"}');
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(() => verifyGitHubSignature(body, signature, secret)).not.toThrow();
    expect(() =>
      verifyGitHubSignature(body, `${signature.slice(0, -1)}0`, secret),
    ).toThrow();
    expect(() => verifyGitHubSignature(body, 'sha1=invalid', secret)).toThrow();
  });

  it('normalizes only durable metadata needed for reconciliation', () => {
    const payload = githubWebhookPayloadSchema.parse({
      action: 'opened',
      repository: { id: 42, full_name: 'FidelCoder/Praxrail' },
      installation: { id: 77 },
      sender: { id: 9, login: 'owner' },
      pull_request: {
        id: 101,
        number: 3,
        state: 'open',
        merged: false,
        html_url: 'https://github.com/FidelCoder/Praxrail/pull/3',
        head: { sha: '1234567890abcdef' },
      },
      untrusted_extra: { authorization: 'should-not-be-normalized' },
    });
    const event = normalizeGitHubEvent('pull_request', payload);
    expect(event.repositoryFullName).toBe('fidelcoder/praxrail');
    expect(event.pullRequest?.number).toBe(3);
    expect(event).not.toHaveProperty('untrusted_extra');
  });
});
