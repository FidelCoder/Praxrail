import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/http/app.js';
import { Metrics } from '../src/observability/metrics.js';
import type { Runtime } from '../src/runtime.js';
import { appConfig } from './fixtures.js';

const apps: ReturnType<typeof createApp>[] = [];

function runtime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    config: appConfig(),
    database: {
      isReady: vi.fn().mockResolvedValue(true),
      query: vi.fn().mockResolvedValue({ rows: [{ tasks_table: 'tasks' }] }),
    },
    queue: {},
    metrics: new Metrics(),
    telegram: {
      process: vi
        .fn()
        .mockResolvedValue({ replayed: false, message: 'accepted' }),
      reject: vi.fn().mockResolvedValue(undefined),
    },
    githubWebhooks: {
      accept: vi.fn().mockResolvedValue({
        replayed: false,
        event: { event: 'pull_request' },
      }),
    },
    planner: {},
    githubApp: null,
    ...overrides,
  } as unknown as Runtime;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('HTTP boundary', () => {
  it('exposes liveness, readiness, and metrics', async () => {
    const app = createApp(runtime());
    apps.push(app);
    expect(
      (await app.inject({ method: 'GET', url: '/health/live' })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/health/ready' })).json(),
    ).toEqual({
      status: 'ready',
      database: true,
      schema: true,
    });
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('praxrail_process_');
  });

  it('hides disabled integration endpoints', async () => {
    const app = createApp(runtime());
    apps.push(app);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/webhooks/telegram/unused-secure-secret',
          payload: { update_id: 1 },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/webhooks/github',
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });

  it('authenticates Telegram before invoking the processor', async () => {
    const telegram = {
      process: vi
        .fn()
        .mockResolvedValue({ replayed: false, message: 'PXR-0001 accepted' }),
      reject: vi.fn().mockResolvedValue(undefined),
    };
    const secret = 'a-secure-telegram-secret';
    const app = createApp(
      runtime({
        config: appConfig({
          telegram: {
            enabled: true,
            botToken: 'a-secure-telegram-bot-token',
            webhookSecret: secret,
            allowedUserIds: new Set([123]),
            allowedChatIds: new Set([456]),
          },
        }),
        telegram,
      } as unknown as Partial<Runtime>),
    );
    apps.push(app);
    const payload = {
      update_id: 1,
      message: {
        message_id: 2,
        date: 1_784_200_000,
        from: { id: 123, first_name: 'Owner' },
        chat: { id: 456, type: 'private' },
        text: '/task Add a frontend test',
      },
    };
    const accepted = await app.inject({
      method: 'POST',
      url: `/webhooks/telegram/${secret}`,
      headers: { 'x-telegram-bot-api-secret-token': secret },
      payload,
    });
    expect(accepted.statusCode).toBe(200);
    expect(telegram.process).toHaveBeenCalledOnce();

    const rejected = await app.inject({
      method: 'POST',
      url: `/webhooks/telegram/${secret}`,
      headers: { 'x-telegram-bot-api-secret-token': secret },
      payload: {
        ...payload,
        update_id: 2,
        message: {
          ...payload.message,
          from: { id: 999, first_name: 'Intruder' },
        },
      },
    });
    expect(rejected.statusCode).toBe(401);
    expect(telegram.process).toHaveBeenCalledOnce();
    expect(telegram.reject).toHaveBeenCalledOnce();
  });

  it('verifies the GitHub signature before accepting a delivery', async () => {
    const secret = 'a-secure-github-webhook-secret';
    const githubWebhooks = {
      accept: vi.fn().mockResolvedValue({
        replayed: false,
        event: { event: 'pull_request' },
      }),
    };
    const app = createApp(
      runtime({
        config: appConfig({
          github: {
            enabled: true,
            appId: 1,
            privateKey: 'unused-test-key',
            webhookSecret: secret,
            allowedRepositories: new Set(['fidelcoder/praxrail']),
          },
        }),
        githubWebhooks,
      } as unknown as Partial<Runtime>),
    );
    apps.push(app);
    const body = JSON.stringify({
      action: 'opened',
      repository: { id: 1, full_name: 'FidelCoder/Praxrail' },
    });
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const headers = {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
      'x-github-delivery': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'x-github-event': 'pull_request',
    };
    const accepted = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers,
      body,
    });
    expect(accepted.statusCode).toBe(202);
    expect(githubWebhooks.accept).toHaveBeenCalledOnce();

    const rejected = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        ...headers,
        'x-hub-signature-256': `${signature.slice(0, -1)}0`,
      },
      body: '{malformed-json',
    });
    expect(rejected.statusCode).toBe(401);
    expect(githubWebhooks.accept).toHaveBeenCalledOnce();
  });
});
