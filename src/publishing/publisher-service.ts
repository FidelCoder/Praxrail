import { createHash, randomUUID } from 'node:crypto';
import type { TaskContract } from '../domain/task-contract.js';
import type { Database } from '../persistence/database.js';
import { GitClient } from '../repositories/git-client.js';
import { assertPushContentSafe } from '../security/release-assessment.js';
import type {
  PullRequestGateway,
  PullRequestRecord,
} from './pull-request-gateway.js';

interface ReviewGateRow {
  status: string;
  reviewed_sha: string;
}

export interface PublishResult {
  commitSha: string;
  pullRequest: PullRequestRecord;
  replayed: boolean;
}

function pullRequestBody(input: {
  taskKey: string;
  contract: TaskContract;
  changeSummary: string;
  verificationSummary: string;
  reviewSummary: string;
}): string {
  const criteria = input.contract.acceptanceCriteria
    .map((criterion) => `- [ ] ${criterion}`)
    .join('\n');
  return [
    `## ${input.taskKey}`,
    '',
    '### Problem',
    input.contract.problem,
    '',
    '### Scope',
    input.contract.includedScope.map((scope) => `- ${scope}`).join('\n'),
    '',
    '### Acceptance criteria',
    criteria,
    '',
    '### Change summary',
    input.changeSummary,
    '',
    '### Verification',
    input.verificationSummary,
    '',
    '### Independent review',
    input.reviewSummary,
    '',
    `Risk: **${input.contract.risk}**. Merge policy: **manual**.`,
  ].join('\n');
}

export class PublisherService {
  constructor(
    private readonly database: Database,
    private readonly pullRequests: PullRequestGateway,
    private readonly git: GitClient = new GitClient(),
  ) {}

  async publish(input: {
    taskId: string;
    taskKey: string;
    repositoryId: string;
    repositoryFullName: string;
    defaultBranch: string;
    worktreePath: string;
    gitRefId: string;
    branchName: string;
    baseSha: string;
    reviewedDiffDigest: string;
    reviewRunId: string;
    contract: TaskContract;
    changeSummary: string;
    verificationSummary: string;
    reviewSummary: string;
    gitIdentity: { name: string; email: string };
  }): Promise<PublishResult> {
    if (
      input.branchName === input.defaultBranch ||
      !input.branchName.startsWith('praxrail/')
    ) {
      throw new Error(
        'Publishing to the default or non-task branch is forbidden',
      );
    }
    const existing = await this.database.query<{
      head_sha: string;
      github_pull_request_id: string;
      number: number;
      url: string;
      state: 'OPEN' | 'CLOSED' | 'MERGED';
    }>(
      `SELECT head_sha, github_pull_request_id::text, number, url, state
       FROM pull_requests WHERE task_id = $1`,
      [input.taskId],
    );
    const prior = existing.rows[0];
    if (prior) {
      return {
        commitSha: prior.head_sha,
        pullRequest: {
          id: Number(prior.github_pull_request_id),
          number: prior.number,
          url: prior.url,
          state: prior.state,
        },
        replayed: true,
      };
    }
    const review = await this.database.query<ReviewGateRow>(
      `SELECT status, reviewed_sha FROM review_runs
       WHERE id = $1 AND task_id = $2`,
      [input.reviewRunId, input.taskId],
    );
    const gate = review.rows[0];
    if (gate?.status !== 'PASSED') {
      throw new Error('Publishing requires a passed independent review');
    }
    if (gate.reviewed_sha !== input.reviewedDiffDigest) {
      throw new Error('Review evidence does not match the requested snapshot');
    }
    const checks = await this.database.query<{
      required_count: string;
      failed_count: string;
    }>(
      `SELECT count(*) FILTER (WHERE required = true)::text AS required_count,
              count(*) FILTER (
                WHERE required = true AND status <> 'PASSED'
              )::text AS failed_count
       FROM verification_runs WHERE task_id = $1`,
      [input.taskId],
    );
    if (
      checks.rows[0]?.required_count === '0' ||
      checks.rows[0]?.failed_count !== '0'
    ) {
      throw new Error('Publishing requires all required verification checks');
    }
    const changedFiles = await this.git.changedFiles(
      input.worktreePath,
      input.baseSha,
    );
    const workingDiff = await this.git.diff(input.worktreePath, input.baseSha);
    assertPushContentSafe(workingDiff, changedFiles);
    const workingDigest = createHash('sha256')
      .update(workingDiff)
      .digest('hex');
    if (workingDigest !== input.reviewedDiffDigest) {
      throw new Error('Final diff changed after independent review');
    }
    await this.git.stageAll(input.worktreePath);
    const treeSha = await this.git.writeTree(input.worktreePath);
    const commitSha = await this.git.commitTree(
      input.worktreePath,
      treeSha,
      input.baseSha,
      `${input.taskKey}: ${input.contract.title}`,
      input.gitIdentity,
    );
    const committedDiff = await this.git.diffBetween(
      input.worktreePath,
      input.baseSha,
      commitSha,
    );
    if (
      createHash('sha256').update(committedDiff).digest('hex') !==
      input.reviewedDiffDigest
    ) {
      throw new Error('Candidate commit differs from the reviewed snapshot');
    }
    await this.git.updateBranch(
      input.worktreePath,
      input.branchName,
      commitSha,
      input.baseSha,
    );
    await this.git.pushBranch(input.worktreePath, input.branchName);
    const pullRequest = await this.pullRequests.createOrUpdate({
      repositoryFullName: input.repositoryFullName,
      branchName: input.branchName,
      defaultBranch: input.defaultBranch,
      title: `${input.taskKey}: ${input.contract.title}`,
      body: pullRequestBody(input),
    });
    await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE git_refs SET head_sha = $2, status = 'PUBLISHED',
           updated_at = now() WHERE id = $1`,
        [input.gitRefId, commitSha],
      );
      await client.query(
        `INSERT INTO pull_requests
          (id, task_id, repository_id, github_pull_request_id, number, url,
           head_sha, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          input.taskId,
          input.repositoryId,
          pullRequest.id,
          pullRequest.number,
          pullRequest.url,
          commitSha,
          pullRequest.state,
        ],
      );
    });
    return { commitSha, pullRequest, replayed: false };
  }
}
