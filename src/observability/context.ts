import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface TraceContext {
  correlationId: string;
  taskId?: string;
  attemptId?: string;
  projectId?: string;
  repositoryId?: string;
  jobId?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

export function runWithTrace<T>(
  context: Partial<TraceContext>,
  operation: () => T,
): T {
  return storage.run(
    { correlationId: context.correlationId ?? randomUUID(), ...context },
    operation,
  );
}

export function currentTrace(): TraceContext {
  return storage.getStore() ?? { correlationId: randomUUID() };
}
