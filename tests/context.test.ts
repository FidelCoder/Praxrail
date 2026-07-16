import { describe, expect, it } from 'vitest';
import { currentTrace, runWithTrace } from '../src/observability/context.js';

describe('trace context', () => {
  it('propagates an explicit correlation and task identity', () => {
    runWithTrace({ correlationId: 'correlation-1', taskId: 'task-1' }, () => {
      expect(currentTrace()).toEqual({
        correlationId: 'correlation-1',
        taskId: 'task-1',
      });
    });
  });

  it('creates a correlation ID when no context is active', () => {
    expect(currentTrace().correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
