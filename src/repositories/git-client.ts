import { execa } from 'execa';

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

const gitEnvironment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: '/tmp/praxrail-git-home',
  LANG: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

export class GitClient {
  async run(
    args: readonly string[],
    options: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<GitCommandResult> {
    const result = await execa('git', [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: gitEnvironment,
      extendEnv: false,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 2 * 1024 * 1024,
      reject: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args[0] ?? 'command'} failed: ${result.stderr.slice(0, 1_000)}`,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  async cloneMirror(cloneUrl: string, mirrorPath: string): Promise<void> {
    await this.run([
      '-c',
      'http.followRedirects=false',
      'clone',
      '--mirror',
      '--no-recurse-submodules',
      cloneUrl,
      mirrorPath,
    ]);
  }

  async fetchMirror(mirrorPath: string): Promise<void> {
    await this.run([
      '--git-dir',
      mirrorPath,
      '-c',
      'http.followRedirects=false',
      'fetch',
      '--prune',
      '--no-tags',
      'origin',
    ]);
  }

  async remoteUrl(mirrorPath: string): Promise<string> {
    return (
      await this.run(['--git-dir', mirrorPath, 'remote', 'get-url', 'origin'])
    ).stdout.trim();
  }

  async resolveRef(mirrorPath: string, reference: string): Promise<string> {
    return (
      await this.run(['--git-dir', mirrorPath, 'rev-parse', reference])
    ).stdout.trim();
  }

  async addWorktree(
    mirrorPath: string,
    worktreePath: string,
    branchName: string,
    baseSha: string,
  ): Promise<void> {
    await this.run([
      '--git-dir',
      mirrorPath,
      'worktree',
      'add',
      '-b',
      branchName,
      worktreePath,
      baseSha,
    ]);
  }

  async removeWorktree(
    mirrorPath: string,
    worktreePath: string,
  ): Promise<void> {
    await this.run([
      '--git-dir',
      mirrorPath,
      'worktree',
      'remove',
      '--force',
      worktreePath,
    ]);
    await this.run(['--git-dir', mirrorPath, 'worktree', 'prune']);
  }

  async headSha(worktreePath: string): Promise<string> {
    return (
      await this.run(['rev-parse', 'HEAD'], { cwd: worktreePath })
    ).stdout.trim();
  }

  async statusPorcelain(worktreePath: string): Promise<string> {
    return (
      await this.run(['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: worktreePath,
      })
    ).stdout;
  }

  async changedFiles(worktreePath: string, baseSha: string): Promise<string[]> {
    const result = await this.run(
      ['diff', '--name-only', '--diff-filter=ACMRD', baseSha, '--'],
      { cwd: worktreePath },
    );
    const tracked = result.stdout.split('\n').filter(Boolean);
    const untracked = (
      await this.run(['ls-files', '--others', '--exclude-standard'], {
        cwd: worktreePath,
      })
    ).stdout
      .split('\n')
      .filter(Boolean);
    return [...new Set([...tracked, ...untracked])].sort();
  }

  async hasSubmoduleChanges(
    worktreePath: string,
    baseSha: string,
  ): Promise<boolean> {
    const result = await this.run(['diff', '--raw', baseSha, '--'], {
      cwd: worktreePath,
    });
    return /^:(?:160000 \d{6}|\d{6} 160000) /m.test(result.stdout);
  }

  async diff(worktreePath: string, baseSha: string): Promise<string> {
    return (
      await this.run(['diff', '--no-ext-diff', '--binary', baseSha, '--'], {
        cwd: worktreePath,
        timeoutMs: 60_000,
      })
    ).stdout;
  }

  async stageAll(worktreePath: string): Promise<void> {
    await this.run(['add', '--all', '--', '.'], { cwd: worktreePath });
  }

  async writeTree(worktreePath: string): Promise<string> {
    return (
      await this.run(['write-tree'], { cwd: worktreePath })
    ).stdout.trim();
  }

  async commitTree(
    worktreePath: string,
    treeSha: string,
    parentSha: string,
    message: string,
    identity: { name: string; email: string },
  ): Promise<string> {
    return (
      await this.run(
        [
          '-c',
          `user.name=${identity.name}`,
          '-c',
          `user.email=${identity.email}`,
          'commit-tree',
          treeSha,
          '-p',
          parentSha,
          '-m',
          message,
        ],
        { cwd: worktreePath },
      )
    ).stdout.trim();
  }

  async updateBranch(
    worktreePath: string,
    branchName: string,
    commitSha: string,
    expectedSha: string,
  ): Promise<void> {
    await this.run(
      ['update-ref', `refs/heads/${branchName}`, commitSha, expectedSha],
      { cwd: worktreePath },
    );
  }

  async diffBetween(
    worktreePath: string,
    baseSha: string,
    headSha: string,
  ): Promise<string> {
    return (
      await this.run(
        ['diff', '--no-ext-diff', '--binary', baseSha, headSha, '--'],
        { cwd: worktreePath },
      )
    ).stdout;
  }

  async pushBranch(worktreePath: string, branchName: string): Promise<void> {
    if (!branchName.startsWith('praxrail/')) {
      throw new Error('Only Praxrail task branches may be pushed');
    }
    await this.run(
      ['push', 'origin', `refs/heads/${branchName}:refs/heads/${branchName}`],
      { cwd: worktreePath, timeoutMs: 120_000 },
    );
  }
}
