import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../persistence/database.js';
import type {
  ExecutionResult,
  RestrictedCommand,
  RestrictedRunner,
} from '../execution/restricted-runner.js';
import { GitClient } from '../repositories/git-client.js';
import type { RepositoryCommand } from '../repositories/policy.js';

export interface VerificationCheck {
  id: string;
  name: string;
  layer: string;
  required: boolean;
  passed: boolean;
  result: ExecutionResult;
}

export interface VerificationSummary {
  version: 1;
  taskId: string;
  attemptId: string;
  baseSha: string;
  headSha: string;
  passed: boolean;
  checks: VerificationCheck[];
  evidenceDigest: string;
}

export class VerificationPipeline {
  constructor(
    private readonly database: Database,
    private readonly runner: RestrictedRunner,
    private readonly git: GitClient = new GitClient(),
  ) {}

  async run(input: {
    taskId: string;
    attemptId: string;
    worktreePath: string;
    baseSha: string;
    commands: RepositoryCommand[];
    container: NonNullable<RestrictedCommand['container']>;
    signal?: AbortSignal;
  }): Promise<VerificationSummary> {
    if (input.commands.length === 0) {
      throw new Error('Verification policy has no commands');
    }
    const checks: VerificationCheck[] = [];
    let priorStatus = await this.git.statusPorcelain(input.worktreePath);
    for (const command of input.commands) {
      const id = randomUUID();
      const startedAt = new Date();
      await this.database.query(
        `INSERT INTO verification_runs
          (id, task_id, attempt_id, name, command, status, required, started_at)
         VALUES ($1, $2, $3, $4, $5, 'RUNNING', $6, $7)`,
        [
          id,
          input.taskId,
          input.attemptId,
          command.name,
          JSON.stringify([command.executable, ...command.args]),
          command.required,
          startedAt,
        ],
      );
      const result = await this.runner.execute(
        {
          executable: command.executable,
          args: command.args,
          cwd: input.worktreePath,
          timeoutMs: command.timeoutMs,
          outputLimitBytes: 512 * 1024,
          diskLimitBytes: 2 * 1024 * 1024 * 1024,
          container: input.container,
        },
        input.signal,
      );
      const nextStatus = await this.git.statusPorcelain(input.worktreePath);
      const modifiedByCheck = nextStatus !== priorStatus;
      const passed = result.failure === 'NONE' && !modifiedByCheck;
      priorStatus = nextStatus;
      await this.database.query(
        `UPDATE verification_runs SET status = $2, exit_code = $3,
           output_reference = $4, completed_at = now()
         WHERE id = $1`,
        [
          id,
          passed ? 'PASSED' : 'FAILED',
          result.exitCode,
          JSON.stringify({
            failure: result.failure,
            durationMs: result.durationMs,
            stdout: result.stdout.slice(0, 32_000),
            stderr: result.stderr.slice(0, 32_000),
            modifiedByCheck,
          }),
        ],
      );
      checks.push({
        id,
        name: command.name,
        layer: command.layer,
        required: command.required,
        passed,
        result,
      });
    }
    const headSha = await this.git.headSha(input.worktreePath);
    const passed = checks.every((check) => !check.required || check.passed);
    const digestInput = checks.map((check) => ({
      name: check.name,
      required: check.required,
      passed: check.passed,
      exitCode: check.result.exitCode,
      failure: check.result.failure,
    }));
    const evidenceDigest = createHash('sha256')
      .update(JSON.stringify(digestInput))
      .digest('hex');
    return {
      version: 1,
      taskId: input.taskId,
      attemptId: input.attemptId,
      baseSha: input.baseSha,
      headSha,
      passed,
      checks,
      evidenceDigest,
    };
  }
}
