import type { Database } from '../../persistence/database.js';
import type {
  PullRequestGateway,
  PullRequestRecord,
} from '../../publishing/pull-request-gateway.js';
import type {
  ExternalPullRequestFacts,
  ReconciliationGateway,
} from '../../recovery/reconciliation-service.js';
import type { GitHubAppClient } from './auth.js';

interface RepositoryInstallation {
  github_installation_id: string;
}

function splitRepository(fullName: string): { owner: string; repo: string } {
  const [owner, repo, extra] = fullName.split('/');
  if (!owner || !repo || extra)
    throw new Error('Repository identity is invalid');
  return { owner, repo };
}

export class GitHubAutomationGateway
  implements PullRequestGateway, ReconciliationGateway
{
  constructor(
    private readonly database: Database,
    private readonly app: GitHubAppClient,
  ) {}

  async createOrUpdate(input: {
    repositoryFullName: string;
    branchName: string;
    defaultBranch: string;
    title: string;
    body: string;
  }): Promise<PullRequestRecord> {
    const { owner, repo } = splitRepository(input.repositoryFullName);
    const client = await this.client(input.repositoryFullName);
    const existing = await client.request('GET /repos/{owner}/{repo}/pulls', {
      owner,
      repo,
      state: 'open',
      head: `${owner}:${input.branchName}`,
      per_page: 2,
    });
    const prior = existing.data[0];
    const pull = prior
      ? await client.request(
          'PATCH /repos/{owner}/{repo}/pulls/{pull_number}',
          {
            owner,
            repo,
            pull_number: prior.number,
            title: input.title,
            body: input.body,
            base: input.defaultBranch,
          },
        )
      : await client.request('POST /repos/{owner}/{repo}/pulls', {
          owner,
          repo,
          head: input.branchName,
          base: input.defaultBranch,
          title: input.title,
          body: input.body,
          maintainer_can_modify: false,
        });
    return {
      id: pull.data.id,
      number: pull.data.number,
      url: pull.data.html_url,
      state: pull.data.merged_at
        ? 'MERGED'
        : pull.data.state === 'closed'
          ? 'CLOSED'
          : 'OPEN',
    };
  }

  async pullRequest(
    repositoryFullName: string,
    number: number,
  ): Promise<ExternalPullRequestFacts> {
    const { owner, repo } = splitRepository(repositoryFullName);
    const client = await this.client(repositoryFullName);
    const pull = await client.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { owner, repo, pull_number: number },
    );
    const checks = await client.request(
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      { owner, repo, ref: pull.data.head.sha, per_page: 100 },
    );
    const statuses = await client.request(
      'GET /repos/{owner}/{repo}/commits/{ref}/status',
      { owner, repo, ref: pull.data.head.sha },
    );
    const pending =
      checks.data.check_runs.some((check) => check.status !== 'completed') ||
      statuses.data.state === 'pending';
    const failed =
      checks.data.check_runs.some(
        (check) =>
          check.status === 'completed' &&
          !['success', 'neutral', 'skipped'].includes(check.conclusion ?? ''),
      ) || ['failure', 'error'].includes(statuses.data.state);
    let branchExists = true;
    try {
      await client.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner,
        repo,
        ref: `heads/${pull.data.head.ref}`,
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      branchExists = false;
    }
    return {
      state: pull.data.state === 'closed' ? 'CLOSED' : 'OPEN',
      merged: pull.data.merged_at !== null,
      headSha: pull.data.head.sha,
      branchExists,
      requiredChecks: failed ? 'FAILED' : pending ? 'PENDING' : 'PASSED',
    };
  }

  private async client(repositoryFullName: string) {
    const installation = await this.database.query<RepositoryInstallation>(
      `SELECT github_installation_id::text FROM repositories
       WHERE lower(full_name) = lower($1) AND enabled = true
         AND onboarding_status = 'APPROVED'`,
      [repositoryFullName],
    );
    const installationId = Number(installation.rows[0]?.github_installation_id);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error('Approved repository installation was not found');
    }
    return this.app.installationClient(installationId, repositoryFullName);
  }
}
