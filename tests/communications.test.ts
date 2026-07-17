import { describe, expect, it, vi } from 'vitest';
import {
  inQuietHours,
  renderChannelEvent,
} from '../src/communications/channel-delivery-service.js';
import { EmailProviderGateway } from '../src/communications/email-provider-gateway.js';
import { normalizedRemoteActionSchema } from '../src/communications/remote-action-service.js';

describe('shared communications', () => {
  it('renders bounded channel-neutral content without active markup', () => {
    const rendered = renderChannelEvent({
      version: 1,
      eventId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      projectId: '33333333-3333-4333-8333-333333333333',
      type: 'TASK_BLOCKED',
      severity: 'CRITICAL',
      title: '<script>alert(1)</script>',
      summary: 'Fix <b>this</b> & inspect the terminal.',
      action: 'STATUS',
      expiresAt: null,
    });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.text).toContain('praxrail task status');
    expect(rendered.text.length).toBeLessThanOrEqual(4_000);
  });

  it('renders runtime notifications without task hints and redacts credential-shaped text', () => {
    const rendered = renderChannelEvent({
      version: 1,
      eventId: '12121212-1212-4212-8212-121212121212',
      taskId: null,
      projectId: null,
      type: 'CONNECTOR_TEST',
      severity: 'INFO',
      title: 'Connector ready',
      summary: 'Provider URL https://user:pass@example.test/path is hidden.',
      action: null,
      expiresAt: null,
    });
    expect(rendered.text).not.toContain('user:pass');
    expect(rendered.text).not.toContain('praxrail task status');
    expect(rendered.html).not.toContain('Action:');
  });

  it('handles same-day and overnight quiet hours in the configured zone', () => {
    expect(
      inQuietHours({
        timezone: 'UTC',
        start: null,
        end: '06:00',
        now: new Date('2026-07-17T23:00:00.000Z'),
      }),
    ).toBe(false);
    expect(
      inQuietHours({
        timezone: 'UTC',
        start: '09:00',
        end: '17:00',
        now: new Date('2026-07-17T10:00:00.000Z'),
      }),
    ).toBe(true);
    expect(
      inQuietHours({
        timezone: 'UTC',
        start: '09:00',
        end: '17:00',
        now: new Date('2026-07-17T18:00:00.000Z'),
      }),
    ).toBe(false);
    expect(
      inQuietHours({
        timezone: 'UTC',
        start: '22:00',
        end: '06:00',
        now: new Date('2026-07-17T23:00:00.000Z'),
      }),
    ).toBe(true);
    expect(
      inQuietHours({
        timezone: 'UTC',
        start: '22:00',
        end: '06:00',
        now: new Date('2026-07-17T12:00:00.000Z'),
      }),
    ).toBe(false);
  });

  it('uses HTTPS, idempotency, and bounded provider responses for email', async () => {
    expect(
      () =>
        new EmailProviderGateway(
          'http://mail.example.test/send',
          'provider-test-key',
          'praxrail@example.test',
        ),
    ).toThrow(/requires HTTPS/);

    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'delivery-1', threadId: 'thread-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const gateway = new EmailProviderGateway(
      'https://mail.example.test/send',
      'provider-test-key',
      'praxrail@example.test',
      fetchImplementation,
    );
    await expect(
      gateway.send({
        destination: 'owner@example.test',
        subject: 'Task blocked',
        text: 'Inspect task',
        html: '<p>Inspect task</p>',
        idempotencyKey: 'notification-task-1',
      }),
    ).resolves.toEqual({
      deliveryId: 'delivery-1',
      threadReference: 'thread-1',
    });
    const firstFetchCall = fetchImplementation.mock.calls[0];
    if (!firstFetchCall) throw new Error('Email gateway did not call fetch');
    const [url, init] = firstFetchCall;
    expect(url).toEqual(new URL('https://mail.example.test/send'));
    expect(init).toMatchObject({ method: 'POST' });
    expect(init?.headers).toMatchObject({
      'idempotency-key': 'notification-task-1',
    });
  });

  it('rejects invalid email configuration and provider failures', async () => {
    expect(
      () =>
        new EmailProviderGateway(
          'https://mail.example.test/send',
          'short',
          'praxrail@example.test',
        ),
    ).toThrow(/API key/);
    expect(
      () =>
        new EmailProviderGateway(
          'https://mail.example.test/send',
          'provider-test-key',
          'not-an-email',
        ),
    ).toThrow(/sender/);

    const rejectedFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('rate limited', {
        status: 429,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const rejectedGateway = new EmailProviderGateway(
      'https://mail.example.test/send',
      'provider-test-key',
      'praxrail@example.test',
      rejectedFetch,
    );
    await expect(
      rejectedGateway.send({
        destination: 'owner@example.test',
        subject: 'Task blocked',
        text: 'Inspect task',
        html: '<p>Inspect task</p>',
        idempotencyKey: 'notification-task-2',
      }),
    ).rejects.toThrow(/429/);

    const acceptedFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'delivery-2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const acceptedGateway = new EmailProviderGateway(
      'https://mail.example.test/send',
      'provider-test-key',
      'praxrail@example.test',
      acceptedFetch,
    );
    await expect(
      acceptedGateway.send({
        destination: 'owner@example.test',
        subject: 'Task blocked',
        text: 'Inspect task',
        html: '<p>Inspect task</p>',
        idempotencyKey: 'notification-task-3',
        threadReference: 'provider-thread-1',
      }),
    ).resolves.toEqual({ deliveryId: 'delivery-2' });
    const acceptedCall = acceptedFetch.mock.calls[0];
    if (!acceptedCall) throw new Error('Email gateway did not call fetch');
    const acceptedRequestBody = acceptedCall[1]?.body;
    if (typeof acceptedRequestBody !== 'string') {
      throw new Error('Email gateway request body was not serialized');
    }
    const acceptedBody = JSON.parse(acceptedRequestBody) as {
      threadReference?: string;
    };
    expect(acceptedBody.threadReference).toBe('provider-thread-1');
  });

  it('normalizes the same remote action contract for both channels', () => {
    for (const channel of ['EMAIL', 'TELEGRAM'] as const) {
      expect(
        normalizedRemoteActionSchema.parse({
          channel,
          externalMessageId: `${channel.toLowerCase()}-1`,
          sender: channel === 'EMAIL' ? 'owner@example.test' : '123456789',
          action: 'STATUS',
          task: 'PXR-0001',
          payload: {},
        }),
      ).toMatchObject({ channel, action: 'STATUS', task: 'PXR-0001' });
    }
  });
});
