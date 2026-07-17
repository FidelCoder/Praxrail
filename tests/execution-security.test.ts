import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { authenticatedEmailSchema } from '../src/integrations/email/intake-service.js';
import { RestrictedRunner } from '../src/execution/restricted-runner.js';
import { escapeTelegramHtml } from '../src/notifications/notification-service.js';
import { projectPolicyPackSchema } from '../src/projects/policy-pack-service.js';
import { evaluateAutoMergeCalibration } from '../src/publishing/auto-merge-policy.js';
import { evaluateMergePolicy } from '../src/publishing/merge-policy.js';
import {
  decideReconciliation,
  type ExternalPullRequestFacts,
} from '../src/recovery/reconciliation-service.js';
import { reportingWindow } from '../src/reporting/daily-report-service.js';
import {
  weeklyRecommendations,
  type WeeklyFacts,
} from '../src/reporting/weekly-report-service.js';
import {
  assertManagedPath,
  assertNoSymlinkEscape,
} from '../src/repositories/path-policy.js';
import { loadRepositoryInstructions } from '../src/repositories/instruction-loader.js';
import {
  canonicalRepositoryIdentity,
  repositoryPolicySchema,
  sanitizeGitSlug,
} from '../src/repositories/policy.js';
import {
  assertPushContentSafe,
  assessReleaseSecurity,
} from '../src/security/release-assessment.js';
import { decideRetry } from '../src/workflow/retry-policy.js';

const pinnedImage = 'node@sha256:' + 'a'.repeat(64);

function repositoryPolicy() {
  return {
    version: 1 as const,
    fullName: 'fidelcoder/praxrail',
    cloneUrl: 'https://github.com/FidelCoder/Praxrail.git',
    defaultBranch: 'main',
    installationId: 123,
    workerProfile: 'general' as const,
    container: {
      image: pinnedImage,
      cpus: 1,
      memoryMb: 1024,
      processLimit: 128,
    },
    writeConcurrency: 1 as const,
    commands: [
      {
        name: 'format',
        layer: 'FORMAT' as const,
        executable: 'pnpm',
        args: ['format:check'],
        required: true,
        timeoutMs: 60_000,
      },
      {
        name: 'lint',
        layer: 'LINT' as const,
        executable: 'pnpm',
        args: ['lint'],
        required: true,
        timeoutMs: 60_000,
      },
      {
        name: 'types',
        layer: 'TYPECHECK' as const,
        executable: 'pnpm',
        args: ['typecheck'],
        required: true,
        timeoutMs: 60_000,
      },
      {
        name: 'unit',
        layer: 'UNIT_TEST' as const,
        executable: 'pnpm',
        args: ['test'],
        required: true,
        timeoutMs: 60_000,
      },
      {
        name: 'build',
        layer: 'BUILD' as const,
        executable: 'pnpm',
        args: ['build'],
        required: true,
        timeoutMs: 60_000,
      },
    ],
    submodules: 'DENY' as const,
    allowedSubmodules: [],
    networkPolicy: 'NONE' as const,
    riskOverrides: {},
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

describe('repository and command containment', () => {
  it('accepts only exact credential-free GitHub repository identities', () => {
    expect(repositoryPolicySchema.parse(repositoryPolicy()).fullName).toBe(
      'fidelcoder/praxrail',
    );
    expect(
      canonicalRepositoryIdentity('https://github.com/FidelCoder/Praxrail.git'),
    ).toBe('fidelcoder/praxrail');
    expect(() =>
      repositoryPolicySchema.parse({
        ...repositoryPolicy(),
        cloneUrl: 'https://github.com/other/project.git',
      }),
    ).toThrow(/identity/);
    expect(() =>
      canonicalRepositoryIdentity(
        'https://token@github.com/FidelCoder/Praxrail.git',
      ),
    ).toThrow(/credential-free/);
    expect(() =>
      repositoryPolicySchema.parse({
        ...repositoryPolicy(),
        container: { ...repositoryPolicy().container, image: 'node:latest' },
      }),
    ).toThrow();
  });

  it('accepts bounded stack-specific worker profiles', () => {
    expect(
      repositoryPolicySchema.parse({
        ...repositoryPolicy(),
        workerProfile: 'data-engineering',
      }).workerProfile,
    ).toBe('data-engineering');
    expect(() =>
      repositoryPolicySchema.parse({
        ...repositoryPolicy(),
        workerProfile: '../../untrusted',
      }),
    ).toThrow();
  });

  it('keeps generated branch slugs bounded and shell-neutral under fuzzing', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const slug = sanitizeGitSlug(value);
        expect(slug).toMatch(/^[a-z0-9-]+$/);
        expect(slug.length).toBeGreaterThan(0);
        expect(slug.length).toBeLessThanOrEqual(48);
      }),
      { numRuns: 500 },
    );
  });

  it('loads layered regular AGENTS.md files and rejects symlink escape', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'praxrail-paths-'));
    try {
      const nested = path.join(root, 'src', 'feature');
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(root, 'AGENTS.md'), 'root policy');
      await writeFile(path.join(root, 'src', 'AGENTS.md'), 'source policy');
      expect(
        (await loadRepositoryInstructions(root, nested)).map(
          (instruction) => instruction.path,
        ),
      ).toEqual(['AGENTS.md', 'src/AGENTS.md']);
      expect(() => assertManagedPath(root, path.join(root, '..'))).toThrow();
      const escaped = path.join(root, 'escape');
      await symlink(tmpdir(), escaped);
      await expect(assertNoSymlinkEscape(root, escaped)).rejects.toThrow(
        /symlink/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires a pinned network-off container unless host mode is test-enabled', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'praxrail-runner-'));
    const work = path.join(root, 'work');
    await mkdir(work);
    const command = {
      executable: 'node',
      args: ['-e', 'process.stdout.write("ok")'],
      cwd: work,
      timeoutMs: 2_000,
      outputLimitBytes: 1_024,
      diskLimitBytes: 1024 * 1024,
    };
    try {
      await expect(new RestrictedRunner(root).execute(command)).rejects.toThrow(
        /Host command execution is disabled/,
      );
      await expect(
        new RestrictedRunner(root).execute({
          ...command,
          container: {
            image: 'node:latest',
            cpus: 1,
            memoryMb: 128,
            processLimit: 32,
            network: 'none',
          },
        }),
      ).rejects.toThrow(/digest-pinned/);
      const runner = new RestrictedRunner(root, { allowHostExecution: true });
      expect((await runner.execute(command)).failure).toBe('NONE');
      await expect(
        runner.execute({
          ...command,
          environment: { GITHUB_TOKEN: 'must-not-pass' },
        }),
      ).rejects.toThrow(/forbidden/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes arguments without a shell and classifies time/output limits', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'praxrail-runner-'));
    const work = path.join(root, 'work');
    await mkdir(work);
    const marker = path.join(root, 'should-not-exist');
    const runner = new RestrictedRunner(root, { allowHostExecution: true });
    const common = {
      cwd: work,
      diskLimitBytes: 1024 * 1024,
    };
    try {
      const injected = await runner.execute({
        ...common,
        executable: 'node',
        args: [
          '-e',
          'process.stdout.write(process.argv[1])',
          ';touch ' + marker,
        ],
        timeoutMs: 2_000,
        outputLimitBytes: 1_024,
      });
      expect(injected.stdout).toContain(';touch');
      expect(await exists(marker)).toBe(false);
      expect(
        (
          await runner.execute({
            ...common,
            executable: 'node',
            args: ['-e', 'setTimeout(() => {}, 1000)'],
            timeoutMs: 50,
            outputLimitBytes: 1_024,
          })
        ).failure,
      ).toBe('TIMEOUT');
      expect(
        (
          await runner.execute({
            ...common,
            executable: 'node',
            args: ['-e', 'process.stdout.write("x".repeat(10000))'],
            timeoutMs: 2_000,
            outputLimitBytes: 128,
          })
        ).failure,
      ).toBe('OUTPUT_LIMIT');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('deterministic release policies', () => {
  it('blocks secret-bearing or forbidden push content', () => {
    expect(() => assertPushContentSafe('diff', ['src/app.ts'])).not.toThrow();
    expect(() =>
      assertPushContentSafe('OPENAI_API_KEY=secret-value', ['src/app.ts']),
    ).toThrow(/secret/);
    expect(() => assertPushContentSafe('diff', ['.env'])).toThrow(
      /forbidden path/,
    );
  });

  it('fails a release on high findings and requires approval for residual risk', () => {
    const base = {
      commitSha: 'a'.repeat(40),
      controls: [
        {
          id: 'webhook-replay',
          passed: true,
          evidence: 'tested',
          severity: 'HIGH' as const,
        },
      ],
      vulnerabilities: [],
      residualRisks: [],
    };
    expect(assessReleaseSecurity(base).status).toBe('PASS');
    const control = base.controls[0];
    if (!control) throw new Error('Expected fixture security control');
    expect(
      assessReleaseSecurity({
        ...base,
        controls: [{ ...control, passed: false }],
      }).status,
    ).toBe('FAIL');
    expect(
      assessReleaseSecurity({
        ...base,
        residualRisks: [
          {
            id: 'availability',
            severity: 'LOW',
            rationale: 'Provider outage',
          },
        ],
      }).status,
    ).toBe('APPROVAL_REQUIRED');
  });

  it('keeps release merge manual and auto-merge disabled without calibration', () => {
    const manual = evaluateMergePolicy({
      risk: 'LOW',
      requiredChecksPassed: true,
      reviewedSha: 'abc',
      headSha: 'abc',
      unresolvedFindings: 0,
      requiredApprovals: 1,
      grantedApprovals: 1,
      branchProtectionSatisfied: true,
      withinBudget: true,
    });
    expect(manual.eligible).toBe(true);
    expect(manual.automaticMergeAllowed).toBe(false);
    expect(
      evaluateAutoMergeCalibration({
        enabled: false,
        killSwitchActive: false,
        ownerApproved: true,
        taskClass: 'docs',
        eligibleTaskClasses: ['docs'],
        sampleSize: 50,
        minimumSampleSize: 30,
        rollbackRate: 0,
        maximumRollbackRate: 0.01,
        risk: 'LOW',
        requiredChecksPassed: true,
        reviewPassed: true,
        headMatchesReview: true,
      }).allowed,
    ).toBe(false);
  });

  it('bounds retries by budget, attempts, review cycles, and no-progress', () => {
    const base = {
      failureClass: 'VERIFICATION' as const,
      attempts: 1,
      reviewCycles: 0,
      maximumAttempts: 3,
      maximumReviewCycles: 2,
      taskSpentUsd: 1,
      taskBudgetUsd: 5,
      dailySpentUsd: 2,
      dailyBudgetUsd: 25,
      diffDigest: 'diff-a',
      errorText: 'test failed at line 42',
      previousDiffDigests: [] as string[],
      previousErrorFingerprints: [] as string[],
    };
    expect(decideRetry(base).action).toBe('RETRY');
    expect(decideRetry({ ...base, taskSpentUsd: 5 }).action).toBe('BLOCK');
    const first = decideRetry(base);
    expect(
      decideRetry({
        ...base,
        previousDiffDigests: ['diff-a'],
        previousErrorFingerprints: [first.errorFingerprint],
      }).action,
    ).toBe('FAIL');
  });

  it('reconciles external GitHub facts without model state', () => {
    const external: ExternalPullRequestFacts = {
      state: 'OPEN',
      merged: true,
      headSha: 'head',
      branchExists: false,
      requiredChecks: 'PASSED',
    };
    expect(
      decideReconciliation({
        taskStatus: 'AWAITING_APPROVAL',
        internalHeadSha: 'head',
        external,
      }),
    ).toBe('MARK_MERGED');
    expect(
      decideReconciliation({
        taskStatus: 'CI',
        internalHeadSha: 'old',
        external: { ...external, merged: false, headSha: 'new' },
      }),
    ).toBe('MARK_CHANGES_REQUESTED');
  });
});

describe('reporting and post-MVP validation', () => {
  it('uses local-day boundaries across daylight-saving changes', () => {
    const spring = reportingWindow(
      new Date('2025-03-10T04:00:00.000Z'),
      'America/New_York',
    );
    expect(spring.end.getTime() - spring.start.getTime()).toBe(
      23 * 60 * 60 * 1000,
    );
    const fall = reportingWindow(
      new Date('2025-11-03T05:00:00.000Z'),
      'America/New_York',
    );
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it('sanitizes Telegram-controlled text under fuzzing', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const escaped = escapeTelegramHtml(value);
        expect(escaped.length).toBeLessThanOrEqual(3_500);
        expect(escaped).not.toMatch(/<(?!\/?(?:b|a)(?:\s|>|$))/i);
      }),
      { numRuns: 300 },
    );
    expect(escapeTelegramHtml('<b>& unsafe')).toBe('&lt;b&gt;&amp; unsafe');
  });

  it('requires authenticated aligned email and sandbox-scanned attachments', () => {
    const valid = {
      provider: 'fixture',
      externalMessageId: 'message-1',
      externalThreadId: 'thread-1',
      sender: 'owner@example.com',
      subject: '[PXR-1] Update validation',
      body: 'Please add the missing validation.',
      authentication: {
        spf: 'PASS',
        dkim: 'PASS',
        dmarc: 'PASS',
        alignedFrom: true,
      },
      attachments: [],
    };
    expect(authenticatedEmailSchema.parse(valid).sender).toBe(
      'owner@example.com',
    );
    expect(
      authenticatedEmailSchema.safeParse({
        ...valid,
        authentication: { ...valid.authentication, dkim: 'FAIL' },
      }).success,
    ).toBe(false);
    expect(
      authenticatedEmailSchema.safeParse({
        ...valid,
        attachments: [
          {
            filename: 'payload.exe',
            mediaType: 'application/octet-stream',
            sizeBytes: 10,
            digest: 'a'.repeat(64),
            scanStatus: 'CLEAN',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('marks weekly recommendations as proposals and validates policy packs', () => {
    const facts: WeeklyFacts = {
      statusCounts: { VERIFIED: 2 },
      costUsd: 3,
      retryCount: 0,
      repeatedFailures: [],
      architectureDecisions: 1,
      unresolvedSecurityFindings: 0,
    };
    expect(weeklyRecommendations(facts)).toEqual([
      {
        kind: 'PROPOSAL',
        action: 'CONTINUE',
        rationale:
          'The ledger contains no repeated failure or blocking security signal.',
      },
    ]);
    expect(
      projectPolicyPackSchema.parse({
        version: 1,
        repositoryIdentities: ['fidelcoder/praxrail'],
        workerPool: 'default',
        portfolioBudgetUsd: 100,
        taskBudgetUsd: 5,
        allowedTaskClasses: ['documentation'],
      }).autoMergeEnabled,
    ).toBe(false);
  });
});
