import { Codex, type ThreadEvent } from '@openai/codex-sdk';

export type AgentRole = 'BUILDER' | 'REVIEWER' | 'REPAIR' | 'REPORTER';

export interface AgentRequest {
  role: AgentRole;
  prompt: string;
  outputSchema: object;
  workingDirectory: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
  resumeThreadId?: string;
}

export interface AgentProviderResult {
  threadId: string;
  finalResponse: string;
  toolActions: Record<string, unknown>[];
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
}

export interface AgentProvider {
  run(request: AgentRequest): Promise<AgentProviderResult>;
}

export interface CodexSdkProviderOptions {
  baseUrl?: string;
}

function boundedToolAction(event: ThreadEvent): Record<string, unknown> | null {
  if (event.type !== 'item.completed') return null;
  const item = event.item;
  switch (item.type) {
    case 'command_execution':
      return {
        type: item.type,
        id: item.id,
        status: item.status,
        exitCode: item.exit_code ?? null,
      };
    case 'file_change':
      return {
        type: item.type,
        id: item.id,
        status: item.status,
        files: item.changes.map((change) => ({
          path: change.path,
          kind: change.kind,
        })),
      };
    case 'mcp_tool_call':
      return {
        type: item.type,
        id: item.id,
        server: item.server,
        tool: item.tool,
        status: item.status,
      };
    case 'web_search':
      return { type: item.type, id: item.id };
    default:
      return null;
  }
}

export class CodexSdkProvider implements AgentProvider {
  constructor(
    private readonly apiKey: string,
    private readonly options: CodexSdkProviderOptions = {},
  ) {}

  async run(request: AgentRequest): Promise<AgentProviderResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    const forwardAbort = () => controller.abort();
    request.signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const codex = new Codex({
        apiKey: this.apiKey,
        ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: '/tmp/praxrail-codex-home',
          LANG: 'C.UTF-8',
        },
        config: {
          web_search: 'disabled',
          sandbox_workspace_write: { network_access: false },
        },
      });
      const options = {
        model: request.model,
        sandboxMode:
          request.role === 'REVIEWER' || request.role === 'REPORTER'
            ? ('read-only' as const)
            : ('workspace-write' as const),
        workingDirectory: request.workingDirectory,
        approvalPolicy: 'never' as const,
        networkAccessEnabled: false,
        webSearchMode: 'disabled' as const,
      };
      const thread = request.resumeThreadId
        ? codex.resumeThread(request.resumeThreadId, options)
        : codex.startThread(options);
      const streamed = await thread.runStreamed(request.prompt, {
        outputSchema: request.outputSchema,
        signal: controller.signal,
      });
      let threadId = request.resumeThreadId ?? '';
      let finalResponse = '';
      const toolActions: Record<string, unknown>[] = [];
      let usage = {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      };
      for await (const event of streamed.events) {
        if (event.type === 'thread.started') threadId = event.thread_id;
        if (
          event.type === 'item.completed' &&
          event.item.type === 'agent_message'
        ) {
          finalResponse = event.item.text;
        }
        if (event.type === 'turn.completed') {
          usage = {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            outputTokens: event.usage.output_tokens,
            reasoningTokens: event.usage.reasoning_output_tokens,
          };
        }
        const action = boundedToolAction(event);
        if (action && toolActions.length < 1_000) toolActions.push(action);
        if (event.type === 'turn.failed' || event.type === 'error') {
          throw new Error(
            event.type === 'turn.failed' ? event.error.message : event.message,
          );
        }
      }
      if (!threadId || !finalResponse) {
        throw new Error(
          'Codex completed without a thread ID or final response',
        );
      }
      return { threadId, finalResponse, toolActions, usage };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', forwardAbort);
    }
  }
}
