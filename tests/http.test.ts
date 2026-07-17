import { createHmac } from 'node:crypto';
import type { ApiActor } from '@praxrail/core';
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
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/runtime' })).statusCode,
    ).toBe(404);
  });

  it('authenticates and authorizes the versioned product API', async () => {
    const owner: ApiActor = {
      identityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tokenId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      actorId: 'owner-1',
      role: 'OWNER',
      projectIds: [],
    };
    const planner: ApiActor = {
      ...owner,
      identityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      tokenId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      actorId: 'planner-1',
      role: 'PLANNER',
    };
    const developer: ApiActor = {
      ...owner,
      identityId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      tokenId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      actorId: 'developer-1',
      role: 'DEVELOPER',
    };
    const reviewer: ApiActor = {
      ...owner,
      identityId: '12121212-1212-4212-8212-121212121212',
      tokenId: '34343434-3434-4434-8434-343434343434',
      actorId: 'reviewer-1',
      role: 'REVIEWER',
    };
    const operator: ApiActor = {
      ...owner,
      identityId: '56565656-5656-4656-8656-565656565656',
      tokenId: '78787878-7878-4878-8878-787878787878',
      actorId: 'operator-1',
      role: 'OPERATOR',
    };
    const auth = {
      authenticate: vi.fn(async (token: string) => {
        if (token.endsWith('planner')) return planner;
        if (token.endsWith('developer')) return developer;
        if (token.endsWith('reviewer')) return reviewer;
        if (token.endsWith('operator')) return operator;
        return owner;
      }),
    };
    const app = createApp(
      runtime({
        config: appConfig({
          api: {
            enabled: true,
            bootstrapToken: `pxr_${'a'.repeat(40)}`,
            bootstrapActorId: 'owner-1',
            bootstrapRole: 'OWNER',
          },
        }),
        started: true,
        auth,
        queries: { active: vi.fn().mockResolvedValue([]) },
      } as unknown as Partial<Runtime>),
    );
    apps.push(app);

    const unauthorized = await app.inject({
      method: 'GET',
      url: '/api/v1/runtime',
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toMatchObject({
      error: 'AUTHENTICATION_FAILED',
      retryable: false,
    });

    const accepted = await app.inject({
      method: 'GET',
      url: '/api/v1/runtime',
      headers: { authorization: `Bearer pxr_${'a'.repeat(40)}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      apiVersion: 'v1',
      status: 'READY',
      mode: 'REMOTE',
    });

    for (const role of ['developer', 'operator']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/runtime',
        headers: { authorization: `Bearer role-${role}` },
      });
      expect(response.statusCode).toBe(200);
    }

    const reviewerTasks = await app.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { authorization: 'Bearer role-reviewer' },
    });
    expect(reviewerTasks.statusCode).toBe(200);

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/runtime',
      headers: { authorization: `Bearer ${'a'.repeat(32)}planner` },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'ACTION_NOT_PERMITTED' });
  });

  it('requires and replays idempotency keys at the API boundary', async () => {
    const operator: ApiActor = {
      identityId: '90909090-9090-4090-8090-909090909090',
      tokenId: 'abababab-abab-4bab-8bab-abababababab',
      actorId: 'operator-api',
      role: 'OPERATOR',
      projectIds: [],
    };
    const worker = {
      id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
      name: 'api-worker',
      mode: 'EMBEDDED',
      version: '0.2.0',
      status: 'ACTIVE',
      profiles: ['frontend'],
      repositoryIds: ['efefefef-efef-4fef-8fef-efefefefefef'],
      capabilities: [],
      fencingToken: '11',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const idempotency = {
      begin: vi
        .fn()
        .mockResolvedValueOnce({ acquired: true, response: null })
        .mockResolvedValueOnce({
          acquired: false,
          response: { data: worker },
        }),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const workers = {
      register: vi.fn().mockResolvedValue(worker),
    };
    const app = createApp(
      runtime({
        config: appConfig({
          api: {
            enabled: true,
            bootstrapToken: `pxr_${'a'.repeat(40)}`,
            bootstrapActorId: operator.actorId,
            bootstrapRole: 'OPERATOR',
          },
        }),
        auth: { authenticate: vi.fn().mockResolvedValue(operator) },
        idempotency,
        workers,
      } as unknown as Partial<Runtime>),
    );
    apps.push(app);
    const request = {
      method: 'POST' as const,
      url: '/api/v1/workers',
      headers: { authorization: `Bearer pxr_${'a'.repeat(40)}` },
      payload: {
        name: worker.name,
        mode: worker.mode,
        version: worker.version,
        profiles: worker.profiles,
        repositoryIds: worker.repositoryIds,
      },
    };

    const missing = await app.inject(request);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: 'INVALID_REQUEST' });

    const keyed = {
      ...request,
      headers: { ...request.headers, 'idempotency-key': 'worker-attempt-1' },
    };
    expect((await app.inject(keyed)).statusCode).toBe(200);
    expect((await app.inject(keyed)).statusCode).toBe(200);
    expect(workers.register).toHaveBeenCalledOnce();
    expect(idempotency.complete).toHaveBeenCalledOnce();
  });

  it('bounds product API requests per authenticated identity', async () => {
    const operator: ApiActor = {
      identityId: '98989898-9898-4898-8898-989898989898',
      tokenId: '76767676-7676-4676-8676-767676767676',
      actorId: 'operator-rate',
      role: 'OPERATOR',
      projectIds: [],
    };
    const app = createApp(
      runtime({
        config: appConfig({
          api: {
            enabled: true,
            bootstrapToken: `pxr_${'a'.repeat(40)}`,
            bootstrapActorId: operator.actorId,
            bootstrapRole: 'OPERATOR',
          },
        }),
        started: true,
        auth: { authenticate: vi.fn().mockResolvedValue(operator) },
      } as unknown as Partial<Runtime>),
    );
    apps.push(app);
    const responses = await Promise.all(
      Array.from({ length: 601 }, () =>
        app.inject({
          method: 'GET',
          url: '/api/v1/runtime',
          headers: { authorization: `Bearer pxr_${'a'.repeat(40)}` },
        }),
      ),
    );
    expect(
      responses.filter((response) => response.statusCode === 429),
    ).toHaveLength(1);
    expect(responses.at(-1)?.json()).toMatchObject({
      error: 'RATE_LIMITED',
      retryable: true,
    });
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
