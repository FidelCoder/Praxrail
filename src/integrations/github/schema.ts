import { z } from 'zod';

const repositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: z.string().min(3).max(256),
  default_branch: z.string().max(256).optional(),
});

export const githubWebhookPayloadSchema = z
  .object({
    action: z.string().max(100).optional(),
    repository: repositorySchema.optional(),
    installation: z.object({ id: z.number().int().positive() }).optional(),
    sender: z
      .object({
        id: z.number().int().positive(),
        login: z.string().max(100),
      })
      .optional(),
    pull_request: z
      .object({
        id: z.number().int().positive(),
        number: z.number().int().positive(),
        state: z.string(),
        merged: z.boolean().optional(),
        html_url: z.url(),
        head: z.object({ sha: z.string().min(7).max(64) }),
      })
      .optional(),
    workflow_run: z
      .object({
        id: z.number().int().positive(),
        status: z.string().nullable(),
        conclusion: z.string().nullable(),
        head_sha: z.string().min(7).max(64),
      })
      .optional(),
    check_run: z
      .object({
        id: z.number().int().positive(),
        status: z.string(),
        conclusion: z.string().nullable(),
        head_sha: z.string().min(7).max(64),
      })
      .optional(),
    ref: z.string().max(1_000).optional(),
    after: z.string().max(64).optional(),
  })
  .loose();

export type GitHubWebhookPayload = z.infer<typeof githubWebhookPayloadSchema>;

export const SUPPORTED_GITHUB_EVENTS = new Set([
  'check_run',
  'check_suite',
  'installation',
  'installation_repositories',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'push',
  'repository',
  'workflow_run',
]);

export interface NormalizedGitHubEvent {
  event: string;
  action?: string;
  repositoryFullName?: string;
  repositoryId?: number;
  installationId?: number;
  senderId?: number;
  pullRequest?: {
    id: number;
    number: number;
    state: string;
    merged: boolean;
    headSha: string;
  };
  workflowRun?: {
    id: number;
    status: string | null;
    conclusion: string | null;
    headSha: string;
  };
  checkRun?: {
    id: number;
    status: string;
    conclusion: string | null;
    headSha: string;
  };
  ref?: string;
  after?: string;
}

export function normalizeGitHubEvent(
  event: string,
  payload: GitHubWebhookPayload,
): NormalizedGitHubEvent {
  return {
    event,
    ...(payload.action ? { action: payload.action } : {}),
    ...(payload.repository
      ? {
          repositoryFullName: payload.repository.full_name.toLowerCase(),
          repositoryId: payload.repository.id,
        }
      : {}),
    ...(payload.installation
      ? { installationId: payload.installation.id }
      : {}),
    ...(payload.sender ? { senderId: payload.sender.id } : {}),
    ...(payload.pull_request
      ? {
          pullRequest: {
            id: payload.pull_request.id,
            number: payload.pull_request.number,
            state: payload.pull_request.state,
            merged: payload.pull_request.merged ?? false,
            headSha: payload.pull_request.head.sha,
          },
        }
      : {}),
    ...(payload.workflow_run
      ? {
          workflowRun: {
            id: payload.workflow_run.id,
            status: payload.workflow_run.status,
            conclusion: payload.workflow_run.conclusion,
            headSha: payload.workflow_run.head_sha,
          },
        }
      : {}),
    ...(payload.check_run
      ? {
          checkRun: {
            id: payload.check_run.id,
            status: payload.check_run.status,
            conclusion: payload.check_run.conclusion,
            headSha: payload.check_run.head_sha,
          },
        }
      : {}),
    ...(payload.ref ? { ref: payload.ref } : {}),
    ...(payload.after ? { after: payload.after } : {}),
  };
}
