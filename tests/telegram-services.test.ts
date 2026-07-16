import { describe, expect, it, vi } from 'vitest';
import { TelegramCommandService } from '../src/integrations/telegram/command-service.js';
import { TelegramProcessor } from '../src/integrations/telegram/processor.js';
import type { DurableQueue } from '../src/jobs/queue.js';
import type { ApprovalService } from '../src/services/approval-service.js';
import type { CostService } from '../src/services/cost-service.js';
import type { IncomingMessageService } from '../src/services/incoming-message-service.js';
import type { TaskQueryService } from '../src/services/task-query-service.js';
import type { TaskService } from '../src/services/task-service.js';
import { appConfig } from './fixtures.js';

const summary = {
  id: '11111111-1111-4111-8111-111111111111',
  taskKey: 'PXR-0001',
  title: 'Test task',
  status: 'READY' as const,
  priority: 50,
  paused: false,
  budgetUsd: 5,
};

function commandHarness() {
  const tasks = {
    setPaused: vi.fn().mockResolvedValue({ ...summary, pausedAt: new Date() }),
    setPriority: vi.fn().mockResolvedValue({ ...summary, priority: 90 }),
  } as unknown as TaskService;
  const queries = {
    resolve: vi.fn().mockResolvedValue(summary),
    active: vi.fn().mockResolvedValue([summary]),
  } as unknown as TaskQueryService;
  const approvals = {
    decide: vi.fn().mockResolvedValue(undefined),
  } as unknown as ApprovalService;
  const costs = {
    totalForTask: vi.fn().mockResolvedValue(1.25),
  } as unknown as CostService;
  return {
    service: new TelegramCommandService(
      appConfig(),
      tasks,
      queries,
      approvals,
      costs,
    ),
    tasks,
    queries,
    approvals,
    costs,
  };
}

describe('Telegram command service', () => {
  it('returns one task or the active task list', async () => {
    const { service } = commandHarness();
    expect(
      (await service.execute({ kind: 'STATUS', task: 'PXR-0001' }, '42'))
        .message,
    ).toBe('PXR-0001: READY');
    expect((await service.execute({ kind: 'STATUS' }, '42')).message).toContain(
      'PXR-0001',
    );
  });

  it('updates pause, resume, and priority through owner-authorized services', async () => {
    const { service, tasks } = commandHarness();
    expect(
      (await service.execute({ kind: 'PAUSE', task: 'PXR-0001' }, '42'))
        .message,
    ).toContain('paused');
    expect(
      (await service.execute({ kind: 'RESUME', task: 'PXR-0001' }, '42'))
        .message,
    ).toContain('resumed');
    expect(
      (
        await service.execute(
          { kind: 'PRIORITY', task: 'PXR-0001', priority: 90 },
          '42',
        )
      ).message,
    ).toContain('90');
    expect(tasks.setPaused).toHaveBeenCalledTimes(2);
    expect(tasks.setPriority).toHaveBeenCalledOnce();
  });

  it('records approval decisions and reports budget limits and spend', async () => {
    const { service, approvals } = commandHarness();
    const approval = {
      approvalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      token: 'abcdefghijklmnopqrstuvwxyz123456',
      reason: 'Owner decision',
    };
    expect(
      (await service.execute({ kind: 'APPROVE', ...approval }, '42')).message,
    ).toBe('Approval recorded.');
    expect(
      (await service.execute({ kind: 'REJECT', ...approval }, '42')).message,
    ).toBe('Rejection recorded.');
    expect(approvals.decide).toHaveBeenCalledTimes(2);
    expect((await service.execute({ kind: 'BUDGET' }, '42')).message).toContain(
      'task $5',
    );
    expect(
      (await service.execute({ kind: 'BUDGET', task: 'PXR-0001' }, '42'))
        .message,
    ).toContain('$1.2500 spent');
  });
});

describe('Telegram processor', () => {
  const envelope = {
    updateId: 1,
    userId: 42,
    chatId: 84,
    text: '/task Add a frontend test',
    externalMessageId: '1',
    raw: {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        from: { id: 42, first_name: 'Owner' },
        chat: { id: 84, type: 'private' as const },
        text: '/task Add a frontend test',
      },
    },
  };

  it('persists a task and retries planning enqueue safely on replay', async () => {
    const tasks = {
      createInboxTask: vi.fn().mockResolvedValue({
        replayed: false,
        task: { id: summary.id, taskKey: summary.taskKey },
      }),
    } as unknown as TaskService;
    const queue = {
      send: vi.fn().mockResolvedValue('job'),
    } as unknown as DurableQueue;
    const processor = new TelegramProcessor(
      tasks,
      {} as IncomingMessageService,
      {} as never,
      queue,
    );
    const result = await processor.process(envelope);
    expect(result.taskId).toBe(summary.id);
    expect(queue.send).toHaveBeenCalledOnce();

    vi.mocked(tasks.createInboxTask).mockResolvedValueOnce({
      replayed: true,
      task: { id: summary.id, taskKey: summary.taskKey } as never,
    });
    expect((await processor.process(envelope)).replayed).toBe(true);
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(queue.send).toHaveBeenLastCalledWith(
      'planning',
      expect.objectContaining({ taskId: summary.id }),
      { idempotencyKey: `planning:${summary.id}` },
    );
  });

  it('persists rejected authentication metadata without reserving the update ID', async () => {
    const incoming = {
      record: vi.fn().mockResolvedValue({ id: 'audit-1', replayed: false }),
    } as unknown as IncomingMessageService;
    const processor = new TelegramProcessor(
      {} as TaskService,
      incoming,
      {} as never,
      {} as DurableQueue,
    );
    await processor.reject(envelope);
    expect(incoming.record).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: 'rejected:1',
        authenticated: false,
        senderId: '42',
      }),
    );
  });

  it('deduplicates operational commands before execution', async () => {
    const incoming = {
      record: vi
        .fn()
        .mockResolvedValueOnce({ id: 'message-1', replayed: false })
        .mockResolvedValueOnce({
          id: 'message-1',
          replayed: true,
        }),
    } as unknown as IncomingMessageService;
    const commands = {
      execute: vi.fn().mockResolvedValue({ message: 'PXR-0001: READY' }),
    };
    const processor = new TelegramProcessor(
      {} as TaskService,
      incoming,
      commands as never,
      {} as DurableQueue,
    );
    const statusEnvelope = { ...envelope, text: '/status PXR-0001' };
    expect((await processor.process(statusEnvelope)).message).toBe(
      'PXR-0001: READY',
    );
    expect((await processor.process(statusEnvelope)).message).toBe(
      'Command already processed.',
    );
    expect(commands.execute).toHaveBeenCalledOnce();
  });
});
