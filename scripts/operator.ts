import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { Database } from '../src/persistence/database.js';
import { OperatorRecoveryService } from '../src/recovery/cleanup-service.js';

const parsed = parseArgs({
  allowPositionals: true,
  strict: true,
  options: {
    actor: { type: 'string' },
    reason: { type: 'string' },
  },
});

const inputSchema = z.object({
  command: z.enum(['release-lock', 'retry-outbox']),
  resourceId: z.uuid(),
  actorId: z.string().min(1).max(200),
  reason: z.string().trim().min(5).max(1_000),
});

const input = inputSchema.parse({
  command: parsed.positionals[0],
  resourceId: parsed.positionals[1],
  actorId: parsed.values.actor,
  reason: parsed.values.reason,
});
const config = loadConfig();
const database = new Database(config.database);
const recovery = new OperatorRecoveryService(database);

try {
  if (input.command === 'release-lock') {
    const released = await recovery.releaseExpiredRepositoryLock({
      repositoryId: input.resourceId,
      actorId: input.actorId,
      reason: input.reason,
    });
    process.stdout.write(
      JSON.stringify({ command: input.command, released }) + '\n',
    );
  } else {
    await recovery.retryOutbox({
      outboxId: input.resourceId,
      actorId: input.actorId,
      reason: input.reason,
    });
    process.stdout.write(
      JSON.stringify({ command: input.command, retried: true }) + '\n',
    );
  }
} finally {
  await database.close();
}
