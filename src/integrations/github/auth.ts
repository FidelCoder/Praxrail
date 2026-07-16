import { createHmac, timingSafeEqual } from 'node:crypto';
import { App } from '@octokit/app';
import type { AppConfig } from '../../config.js';
import {
  AuthenticationError,
  AuthorizationError,
} from '../../domain/errors.js';

export function verifyGitHubSignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
): void {
  if (!signature.startsWith('sha256=')) throw new AuthenticationError();
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const actualBytes = Buffer.from(signature, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw new AuthenticationError();
  }
}

export class GitHubAppClient {
  private readonly app: App;

  constructor(private readonly config: AppConfig['github']) {
    if (
      !config.enabled ||
      !config.appId ||
      !config.privateKey ||
      !config.webhookSecret
    ) {
      throw new Error('GitHub App is not fully configured');
    }
    this.app = new App({
      appId: config.appId,
      privateKey: config.privateKey,
      webhooks: { secret: config.webhookSecret },
    });
  }

  assertRepositoryAllowed(fullName: string): void {
    if (!this.config.allowedRepositories.has(fullName.toLowerCase())) {
      throw new AuthorizationError(`Repository ${fullName} is not allowed`);
    }
  }

  async installationClient(
    installationId: number,
    repositoryFullName: string,
  ): Promise<Awaited<ReturnType<App['getInstallationOctokit']>>> {
    this.assertRepositoryAllowed(repositoryFullName);
    return this.app.getInstallationOctokit(installationId);
  }
}
