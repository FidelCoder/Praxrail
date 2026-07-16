import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TaskContract } from '../domain/task-contract.js';
import type { Database } from '../persistence/database.js';
import { GitClient } from '../repositories/git-client.js';
import type { RepositoryInstruction } from '../repositories/instruction-loader.js';
import {
  reviewCompletionJsonSchema,
  reviewCompletionSchema,
  type ReviewCompletion,
} from './contracts.js';
import type { AgentProvider } from './provider.js';
import { reviewerPrompt } from './prompts.js';

export class ReviewService {
  constructor(
    private readonly database: Database,
    private readonly provider: AgentProvider,
    private readonly git: GitClient = new GitClient(),
  ) {}

  async review(input: {
    taskId: string;
    attemptId: string;
    worktreePath: string;
    baseSha: string;
    reviewedSha: string;
    contract: TaskContract;
    instructions: RepositoryInstruction[];
    verification: unknown;
    changedFiles: string[];
    workerProfile: string;
    model: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ reviewRunId: string; completion: ReviewCompletion }> {
    const before = await this.git.diff(input.worktreePath, input.baseSha);
    const beforeDigest = createHash('sha256').update(before).digest('hex');
    if (beforeDigest !== input.reviewedSha) {
      throw new Error('Reviewed SHA does not match the worktree snapshot');
    }
    const agentRunId = randomUUID();
    const reviewRunId = randomUUID();
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO agent_runs
          (id, task_id, attempt_id, role, worker_profile, prompt_version, model,
           base_sha, head_sha, status)
         VALUES ($1, $2, $3, 'REVIEWER', $4, 'reviewer-v1', $5, $6, $7, 'RUNNING')`,
        [
          agentRunId,
          input.taskId,
          input.attemptId,
          input.workerProfile,
          input.model,
          input.baseSha,
          input.reviewedSha,
        ],
      );
      await client.query(
        `INSERT INTO review_runs
          (id, task_id, attempt_id, agent_run_id, reviewed_sha, status)
         VALUES ($1, $2, $3, $4, $5, 'RUNNING')`,
        [
          reviewRunId,
          input.taskId,
          input.attemptId,
          agentRunId,
          input.reviewedSha,
        ],
      );
    });
    try {
      const result = await this.provider.run({
        role: 'REVIEWER',
        prompt: reviewerPrompt({
          contract: input.contract,
          instructions: input.instructions,
          baseSha: input.baseSha,
          headSha: input.reviewedSha,
          diff: before,
          verification: input.verification,
        }),
        outputSchema: reviewCompletionJsonSchema,
        workingDirectory: input.worktreePath,
        model: input.model,
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const completion = reviewCompletionSchema.parse(
        JSON.parse(result.finalResponse) as unknown,
      );
      const changed = new Set(input.changedFiles);
      for (const finding of completion.findings) {
        if (!changed.has(finding.file)) {
          throw new Error(
            `Review finding cites unchanged file ${finding.file}`,
          );
        }
        const filePath = path.resolve(input.worktreePath, finding.file);
        const relative = path.relative(input.worktreePath, filePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error('Review finding path escapes the worktree');
        }
        const lineCount = (await readFile(filePath, 'utf8')).split('\n').length;
        if (finding.line > lineCount) {
          throw new Error(
            `Review finding line does not exist: ${finding.file}:${finding.line}`,
          );
        }
      }
      const after = await this.git.diff(input.worktreePath, input.baseSha);
      if (createHash('sha256').update(after).digest('hex') !== beforeDigest) {
        throw new Error('Read-only reviewer modified the worktree');
      }
      const blocking = completion.findings.some((finding) =>
        ['CRITICAL', 'HIGH', 'MEDIUM'].includes(finding.severity),
      );
      await this.database.transaction(async (client) => {
        await client.query(
          `UPDATE agent_runs SET thread_id = $2, status = 'COMPLETED',
             input_tokens = $3, cached_input_tokens = $4, output_tokens = $5,
             reasoning_tokens = $6, tool_actions = $7, result = $8,
             completed_at = now() WHERE id = $1`,
          [
            agentRunId,
            result.threadId,
            result.usage.inputTokens,
            result.usage.cachedInputTokens,
            result.usage.outputTokens,
            result.usage.reasoningTokens,
            JSON.stringify(result.toolActions),
            completion,
          ],
        );
        await client.query(
          `UPDATE review_runs SET status = $2, summary = $3,
             completed_at = now() WHERE id = $1`,
          [
            reviewRunId,
            blocking ? 'CHANGES_REQUESTED' : 'PASSED',
            completion.summary,
          ],
        );
        for (const finding of completion.findings) {
          await client.query(
            `INSERT INTO review_findings
              (id, task_id, attempt_id, reviewed_sha, severity, file_path,
               line_number, title, rationale, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN')`,
            [
              randomUUID(),
              input.taskId,
              input.attemptId,
              input.reviewedSha,
              finding.severity,
              finding.file,
              finding.line,
              finding.title,
              `${finding.rationale}\n\nScenario: ${finding.failureScenario}\n\nSuggested: ${finding.suggestedResolution}`,
            ],
          );
        }
      });
      return { reviewRunId, completion };
    } catch (error) {
      await this.database.transaction(async (client) => {
        await client.query(
          `UPDATE agent_runs SET status = 'FAILED', failure_class = 'REVIEW',
             failure_message = $2, completed_at = now() WHERE id = $1`,
          [
            agentRunId,
            error instanceof Error
              ? error.message.slice(0, 1_000)
              : 'Review failed',
          ],
        );
        await client.query(
          `UPDATE review_runs SET status = 'FAILED', completed_at = now()
           WHERE id = $1`,
          [reviewRunId],
        );
      });
      throw error;
    }
  }
}
