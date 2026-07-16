import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { TaskContract } from '../domain/task-contract.js';
import type { Database } from '../persistence/database.js';
import { GitClient } from '../repositories/git-client.js';
import type { RepositoryInstruction } from '../repositories/instruction-loader.js';
import {
  builderCompletionJsonSchema,
  builderCompletionSchema,
  type BuilderCompletion,
} from './contracts.js';
import { builderPrompt } from './prompts.js';
import type { AgentProvider, AgentRole } from './provider.js';

function assertRelativeFiles(files: readonly string[]): void {
  for (const file of files) {
    const normalized = path.posix.normalize(file.replaceAll('\\', '/'));
    if (
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      path.posix.isAbsolute(normalized)
    ) {
      throw new Error(`Agent reported an invalid changed path: ${file}`);
    }
  }
}

export interface BuilderRunResult {
  agentRunId: string;
  threadId: string;
  completion: BuilderCompletion;
  changedFiles: string[];
  diffDigest: string;
}

export class BuilderService {
  constructor(
    private readonly database: Database,
    private readonly provider: AgentProvider,
    private readonly git: GitClient = new GitClient(),
  ) {}

  async run(input: {
    taskId: string;
    attemptId?: string;
    role?: Extract<AgentRole, 'BUILDER' | 'REPAIR'>;
    workerProfile: string;
    worktreePath: string;
    baseSha: string;
    contract: TaskContract;
    instructions: RepositoryInstruction[];
    model: string;
    timeoutMs: number;
    signal?: AbortSignal;
    repairContext?: string[];
    resumeThreadId?: string;
  }): Promise<BuilderRunResult> {
    const agentRunId = randomUUID();
    const role = input.role ?? 'BUILDER';
    await this.database.query(
      `INSERT INTO agent_runs
        (id, task_id, attempt_id, role, worker_profile, prompt_version, model,
         base_sha, status)
       VALUES ($1, $2, $3, $4, $5, 'builder-v1', $6, $7, 'RUNNING')`,
      [
        agentRunId,
        input.taskId,
        input.attemptId ?? null,
        role,
        input.workerProfile,
        input.model,
        input.baseSha,
      ],
    );
    try {
      const result = await this.provider.run({
        role,
        prompt: builderPrompt({
          contract: input.contract,
          instructions: input.instructions,
          baseSha: input.baseSha,
          worktreePath: input.worktreePath,
          budgetUsd: input.contract.budgetUsd,
          ...(input.repairContext
            ? { repairContext: input.repairContext }
            : {}),
        }),
        outputSchema: builderCompletionJsonSchema,
        workingDirectory: input.worktreePath,
        model: input.model,
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.resumeThreadId
          ? { resumeThreadId: input.resumeThreadId }
          : {}),
      });
      const completion = builderCompletionSchema.parse(
        JSON.parse(result.finalResponse) as unknown,
      );
      assertRelativeFiles(completion.changedFiles);
      const changedFiles = await this.git.changedFiles(
        input.worktreePath,
        input.baseSha,
      );
      assertRelativeFiles(changedFiles);
      if (
        JSON.stringify([...completion.changedFiles].sort()) !==
        JSON.stringify(changedFiles)
      ) {
        throw new Error(
          'Builder changed-file claims do not match Git evidence',
        );
      }
      const diff = await this.git.diff(input.worktreePath, input.baseSha);
      const diffDigest = createHash('sha256').update(diff).digest('hex');
      await this.database.query(
        `UPDATE agent_runs SET thread_id = $2, status = 'COMPLETED',
           input_tokens = $3, cached_input_tokens = $4, output_tokens = $5,
           reasoning_tokens = $6, tool_actions = $7, result = $8,
           completed_at = now()
         WHERE id = $1`,
        [
          agentRunId,
          result.threadId,
          result.usage.inputTokens,
          result.usage.cachedInputTokens,
          result.usage.outputTokens,
          result.usage.reasoningTokens,
          JSON.stringify(result.toolActions),
          { ...completion, changedFiles, diffDigest },
        ],
      );
      if (input.attemptId) {
        await this.database.query(
          `UPDATE task_attempts SET codex_thread_id = $2,
             prompt_version = 'builder-v1', model = $3, diff_digest = $4
           WHERE id = $1`,
          [input.attemptId, result.threadId, input.model, diffDigest],
        );
      }
      return {
        agentRunId,
        threadId: result.threadId,
        completion,
        changedFiles,
        diffDigest,
      };
    } catch (error) {
      const cancelled = input.signal?.aborted ?? false;
      await this.database.query(
        `UPDATE agent_runs SET status = $2, failure_class = $3,
           failure_message = $4, completed_at = now() WHERE id = $1`,
        [
          agentRunId,
          cancelled ? 'CANCELLED' : 'FAILED',
          cancelled ? 'CANCELLED' : 'BUILDER',
          error instanceof Error
            ? error.message.slice(0, 1_000)
            : 'Builder failed',
        ],
      );
      throw error;
    }
  }
}
