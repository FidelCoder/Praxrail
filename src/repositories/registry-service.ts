import { createHash, randomUUID } from 'node:crypto';
import { access, lstat } from 'node:fs/promises';
import path from 'node:path';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import type { ExecutionResult } from '../execution/restricted-runner.js';
import type { Database } from '../persistence/database.js';
import { GitClient } from './git-client.js';
import { loadRepositoryInstructions } from './instruction-loader.js';
import {
  canonicalRepositoryIdentity,
  repositoryPolicySchema,
  type RepositoryPolicy,
} from './policy.js';

interface InspectionRow {
  safe_for_writes: boolean;
  repository_id: string;
}

export interface OnboardingReport {
  id: string;
  repositoryId: string;
  commitSha: string;
  safeForWrites: boolean;
  findings: string[];
}

export class RepositoryRegistryService {
  constructor(
    private readonly database: Database,
    private readonly git: GitClient = new GitClient(),
  ) {}

  async registerCandidate(input: {
    projectId: string;
    githubRepositoryId: number;
    policy: RepositoryPolicy;
    mirrorPath: string;
  }): Promise<string> {
    const policy = repositoryPolicySchema.parse(input.policy);
    const repositoryId = randomUUID();
    await this.database.query(
      `INSERT INTO repositories
        (id, project_id, github_repository_id, full_name, clone_url,
         default_branch, github_installation_id, worker_profile,
         write_concurrency, verification_commands, policy, enabled,
         mirror_path, onboarding_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, false, $11, 'PENDING')
       ON CONFLICT (full_name) DO UPDATE SET
         clone_url = EXCLUDED.clone_url,
         default_branch = EXCLUDED.default_branch,
         github_installation_id = EXCLUDED.github_installation_id,
         worker_profile = EXCLUDED.worker_profile,
         verification_commands = EXCLUDED.verification_commands,
         policy = EXCLUDED.policy,
         mirror_path = EXCLUDED.mirror_path,
         enabled = false,
         onboarding_status = 'PENDING',
         updated_at = now()`,
      [
        repositoryId,
        input.projectId,
        input.githubRepositoryId,
        policy.fullName,
        policy.cloneUrl,
        policy.defaultBranch,
        policy.installationId,
        policy.workerProfile,
        JSON.stringify(policy.commands.map((command) => command.name)),
        policy,
        input.mirrorPath,
      ],
    );
    const existing = await this.database.query<{ id: string }>(
      'SELECT id FROM repositories WHERE full_name = $1',
      [policy.fullName],
    );
    const id = existing.rows[0]?.id;
    if (!id) throw new Error('Repository registration returned no identifier');
    return id;
  }

  async inspect(input: {
    repositoryId: string;
    checkoutPath: string;
    policy: RepositoryPolicy;
    commandResults: ExecutionResult[];
    actorId: string;
  }): Promise<OnboardingReport> {
    const policy = repositoryPolicySchema.parse(input.policy);
    const findings: string[] = [];
    const remote = (
      await this.git.run(['remote', 'get-url', 'origin'], {
        cwd: input.checkoutPath,
      })
    ).stdout.trim();
    try {
      if (
        canonicalRepositoryIdentity(remote) !==
        canonicalRepositoryIdentity(policy.cloneUrl)
      ) {
        findings.push('Git remote identity does not match repository policy');
      }
    } catch {
      findings.push('Git remote is not a credential-free GitHub HTTPS URL');
    }
    const instructions = await loadRepositoryInstructions(input.checkoutPath);
    if (instructions.length === 0) findings.push('Root AGENTS.md is missing');
    const gitmodules = path.join(input.checkoutPath, '.gitmodules');
    try {
      const stat = await lstat(gitmodules);
      if (stat.isSymbolicLink())
        findings.push('.gitmodules cannot be a symlink');
      if (policy.submodules === 'DENY')
        findings.push('Submodules are forbidden');
    } catch (error) {
      const missing =
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing) throw error;
    }
    const failedCommands = input.commandResults.filter(
      (result) => result.failure !== 'NONE',
    );
    if (failedCommands.length > 0) {
      findings.push(`${failedCommands.length} onboarding commands failed`);
    }
    await access(input.checkoutPath);
    const commitSha = (
      await this.git.run(['rev-parse', 'HEAD'], { cwd: input.checkoutPath })
    ).stdout.trim();
    const safeForWrites = findings.length === 0;
    const reportId = randomUUID();
    const instructionsDigest = createHash('sha256')
      .update(instructions.map((entry) => entry.digest).join(':'))
      .digest('hex');
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO repository_onboarding_reports
          (id, repository_id, commit_sha, policy, instructions, findings,
           command_results, safe_for_writes, inspected_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          reportId,
          input.repositoryId,
          commitSha,
          policy,
          JSON.stringify(
            instructions.map(({ path: instructionPath, digest }) => ({
              path: instructionPath,
              digest,
            })),
          ),
          JSON.stringify(findings),
          JSON.stringify(input.commandResults),
          safeForWrites,
          input.actorId,
        ],
      );
      await client.query(
        `UPDATE repositories SET onboarding_status = $2,
           onboarding_report = $3, instructions_digest = $4,
           enabled = false, updated_at = now()
         WHERE id = $1`,
        [
          input.repositoryId,
          safeForWrites ? 'PENDING' : 'BLOCKED',
          { reportId, findings, commitSha },
          instructionsDigest,
        ],
      );
    });
    return {
      id: reportId,
      repositoryId: input.repositoryId,
      commitSha,
      safeForWrites,
      findings,
    };
  }

  async approve(
    repositoryId: string,
    reportId: string,
    ownerActorId: string,
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query<InspectionRow>(
        `SELECT safe_for_writes, repository_id
         FROM repository_onboarding_reports
         WHERE id = $1 FOR UPDATE`,
        [reportId],
      );
      const report = result.rows[0];
      if (!report) throw new NotFoundError('Onboarding report was not found');
      if (report.repository_id !== repositoryId) {
        throw new ConflictError(
          'Onboarding report belongs to another repository',
        );
      }
      if (!report.safe_for_writes) {
        throw new ConflictError('Unsafe onboarding report cannot be approved');
      }
      const updated = await client.query(
        `UPDATE repositories SET onboarding_status = 'APPROVED',
           enabled = true, approved_at = now(), approved_by = $2,
           updated_at = now()
         WHERE id = $1`,
        [repositoryId, ownerActorId],
      );
      if (updated.rowCount !== 1) {
        throw new NotFoundError('Repository was not found');
      }
    });
  }
}
