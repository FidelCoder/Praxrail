import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import { registerProductApi } from '../api/routes.js';
import { verifyGitHubSignature } from '../integrations/github/auth.js';
import { authenticateTelegram } from '../integrations/telegram/auth.js';
import { SenderRateLimiter } from '../integrations/telegram/rate-limiter.js';
import { normalizeTelegramUpdate } from '../integrations/telegram/schema.js';
import {
  loggerRedactPaths,
  redactSensitive,
} from '../observability/redaction.js';
import { runWithTrace } from '../observability/context.js';
import type { Runtime } from '../runtime.js';

const telegramParamsSchema = z.object({ secret: z.string().min(16).max(256) });
const deliveryIdSchema = z.uuid();
const eventNameSchema = z
  .string()
  .regex(/^[a-z_]+$/)
  .max(100);

function requiredHeader(
  value: string | string[] | undefined,
  name: string,
): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Missing ${name} header`);
  return value;
}

function bufferedBody(body: unknown): Buffer {
  if (!Buffer.isBuffer(body)) throw new Error('Expected a buffered JSON body');
  if (body.length > 1_048_576) throw new Error('Request body is too large');
  return body;
}

function parseJson(raw: Buffer): unknown {
  return JSON.parse(raw.toString('utf8')) as unknown;
}

async function schemaReady(runtime: Runtime): Promise<boolean> {
  try {
    const result = await runtime.database.query<{ tasks_table: string | null }>(
      "SELECT to_regclass('public.tasks')::text AS tasks_table",
    );
    return result.rows[0]?.tasks_table === 'tasks';
  } catch {
    return false;
  }
}

export function createApp(runtime: Runtime): FastifyInstance {
  const app = Fastify({
    bodyLimit: 1_048_576,
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
    logger: {
      level: runtime.config.logLevel,
      redact: { paths: loggerRedactPaths, censor: '[REDACTED]' },
      genReqId: () => randomUUID(),
    },
  });
  const telegramRateLimiter = new SenderRateLimiter();

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );
  app.addHook('onRequest', (request, reply, done) => {
    runWithTrace({ correlationId: request.id }, () => {
      void reply.header('x-correlation-id', request.id);
      done();
    });
  });

  app.get('/health/live', () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const database = await runtime.database.isReady();
    runtime.metrics.databaseReady.set(database ? 1 : 0);
    const schema = database ? await schemaReady(runtime) : false;
    const ready = database && schema;
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'not_ready', database, schema });
  });
  app.get('/metrics', async (_request, reply) => {
    return reply
      .header('content-type', runtime.metrics.registry.contentType)
      .send(await runtime.metrics.render());
  });

  registerProductApi(app, runtime);

  app.post('/webhooks/telegram/:secret', async (request, reply) => {
    if (
      !runtime.config.telegram.enabled ||
      !runtime.config.telegram.webhookSecret
    ) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const params = telegramParamsSchema.parse(request.params);
    const raw = bufferedBody(request.body);
    const envelope = normalizeTelegramUpdate(parseJson(raw));
    const headerSecret = request.headers['x-telegram-bot-api-secret-token'];
    try {
      authenticateTelegram({
        configuredSecret: runtime.config.telegram.webhookSecret,
        pathSecret: params.secret,
        ...(typeof headerSecret === 'string' ? { headerSecret } : {}),
        userId: envelope.userId,
        chatId: envelope.chatId,
        allowedUserIds: runtime.config.telegram.allowedUserIds,
        allowedChatIds: runtime.config.telegram.allowedChatIds,
      });
    } catch (error) {
      await runtime.telegram.reject(envelope);
      runtime.metrics.externalEvents.inc({
        provider: 'telegram',
        event: 'update',
        result: 'rejected',
      });
      throw error;
    }
    if (!telegramRateLimiter.allow(envelope.userId)) {
      runtime.metrics.externalEvents.inc({
        provider: 'telegram',
        event: 'update',
        result: 'rate_limited',
      });
      return reply.code(429).send({ error: 'rate_limited' });
    }
    const result = await runtime.telegram.process(envelope);
    runtime.metrics.externalEvents.inc({
      provider: 'telegram',
      event: 'update',
      result: result.replayed ? 'replayed' : 'accepted',
    });
    return reply.code(200).send({ ok: true, ...result });
  });

  app.post('/webhooks/github', async (request, reply) => {
    if (
      !runtime.config.github.enabled ||
      !runtime.config.github.webhookSecret
    ) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const signature = requiredHeader(
      request.headers['x-hub-signature-256'],
      'x-hub-signature-256',
    );
    const deliveryId = deliveryIdSchema.parse(
      requiredHeader(request.headers['x-github-delivery'], 'x-github-delivery'),
    );
    const eventName = eventNameSchema.parse(
      requiredHeader(request.headers['x-github-event'], 'x-github-event'),
    );
    const raw = bufferedBody(request.body);
    verifyGitHubSignature(raw, signature, runtime.config.github.webhookSecret);
    const parsed = parseJson(raw);
    const result = await runtime.githubWebhooks.accept({
      deliveryId,
      eventName,
      rawBody: raw,
      parsedBody: parsed,
    });
    runtime.metrics.externalEvents.inc({
      provider: 'github',
      event: eventName,
      result: result.replayed ? 'replayed' : 'accepted',
    });
    return reply.code(202).send({ accepted: true, replayed: result.replayed });
  });

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.id;
    if (error instanceof DomainError) {
      const status =
        error.code === 'AUTHENTICATION_FAILED'
          ? 401
          : error.code === 'ACTION_NOT_PERMITTED'
            ? 403
            : error.code === 'INVALID_REQUEST'
              ? 400
              : error.code === 'NOT_FOUND'
                ? 404
                : error.code === 'RATE_LIMITED'
                  ? 429
                  : 409;
      request.log.warn({ correlationId, code: error.code }, 'Request rejected');
      return reply.code(status).send({
        error: error.code,
        message: error.message,
        correlationId,
        retryable: error.code === 'RATE_LIMITED',
      });
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      request.log.warn({ correlationId }, 'Invalid request');
      return reply.code(400).send({
        error: 'INVALID_REQUEST',
        message: 'The request is invalid',
        correlationId,
        retryable: false,
      });
    }
    request.log.error(
      { correlationId, error: redactSensitive(error) },
      'Request failed',
    );
    return reply.code(500).send({
      error: 'INTERNAL_ERROR',
      message: 'The request failed',
      correlationId,
      retryable: false,
    });
  });

  return app;
}
