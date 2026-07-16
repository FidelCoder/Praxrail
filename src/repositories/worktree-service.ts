import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import type {
  RepositoryLock,
  RepositoryLockService,
} from '../jobs/repository-lock.js';
import type { Database } from '../persistence/database.js';
import { GitClient } from './git-client.js';
import { assertManagedPath, assertNoSymlinkEscape } from './path-policy.js';
import { canonicalRepositoryIdentity, sanitizeGitSlug } from './policy.js';

export interface RepositoryCheckout {
  id: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
}

export interface TaskWorktree {
  gitRefId: string;
  repositoryId: string;
  taskId: string;
  attemptId?: string;
  mirrorPath: string;
  worktreePath: string;
  branchName: string;
  baseSha: string;
  fencingToken: bigint;
  lock: RepositoryLock;
}

interface GitRefRow {
  worktree_path: string | null;
  fencing_token: string | null;
}

export class WorktreeService {
  constructor(
    private readonly database: Database,
    private readonly locks: RepositoryLockService,
    private readonly mirrorRoot: string,
    private readonly worktreeRoot: string,
    private readonly git: GitClient = new GitClient(),
  ) {}

  async create(input: {
    repository: RepositoryCheckout;
    taskId: string;
    taskKey: string;
    taskTitle: string;
    attemptId?: string;
    attemptNumber: number;
    workerId: string;
    leaseMilliseconds: number;
  }): Promise<TaskWorktree> {
    const existing = await this.database.query<GitRefRow>(
      `SELECT worktree_path, fencing_token::text
       FROM git_refs
       WHERE task_id = $1 AND attempt_id IS NOT DISTINCT FROM $2
         AND status = 'ACTIVE'`,
      [input.taskId, input.attemptId ?? null],
    );
    const prior = existing.rows[0];
    if (prior?.worktree_path && prior.fencing_token) {
      throw new ConflictError(
        `Attempt already owns active worktree ${prior.worktree_path}`,
      );
    }
    const lock = await this.locks.acquire({
      repositoryId: input.repository.id,
      taskId: input.taskId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      workerId: input.workerId,
      leaseMilliseconds: input.leaseMilliseconds,
    });
    if (!lock) throw new ConflictError('Repository write lock is unavailable');

    await mkdir(this.mirrorRoot, { recursive: true });
    await mkdir(this.worktreeRoot, { recursive: true });
    const mirrorPath = assertManagedPath(
      this.mirrorRoot,
      path.join(this.mirrorRoot, `${input.repository.id}.git`),
    );
    const worktreeName = [
      input.taskKey.toLowerCase(),
      sanitizeGitSlug(input.taskTitle),
      `a${input.attemptNumber}`,
    ].join('-');
    const worktreePath = assertManagedPath(
      this.worktreeRoot,
      path.join(this.worktreeRoot, worktreeName),
    );
    await assertNoSymlinkEscape(this.mirrorRoot, mirrorPath, true);
    await assertNoSymlinkEscape(this.worktreeRoot, worktreePath, true);
    const branchName = `praxrail/${worktreeName}`;
    try {
      let mirrorExists = true;
      try {
        await access(mirrorPath);
      } catch {
        mirrorExists = false;
      }
      if (!mirrorExists) {
        await this.git.cloneMirror(input.repository.cloneUrl, mirrorPath);
      } else {
        await this.git.fetchMirror(mirrorPath);
      }
      const remote = await this.git.remoteUrl(mirrorPath);
      if (
        canonicalRepositoryIdentity(remote) !==
        canonicalRepositoryIdentity(input.repository.cloneUrl)
      ) {
        throw new ConflictError('Repository mirror remote identity changed');
      }
      const baseSha = await this.git.resolveRef(
        mirrorPath,
        `refs/heads/${input.repository.defaultBranch}`,
      );
      await this.git.addWorktree(mirrorPath, worktreePath, branchName, baseSha);
      const gitRefId = randomUUID();
      await this.database.query(
        `INSERT INTO git_refs
          (id, task_id, attempt_id, repository_id, base_sha, branch_name,
           worktree_path, fencing_token, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE')`,
        [
          gitRefId,
          input.taskId,
          input.attemptId ?? null,
          input.repository.id,
          baseSha,
          branchName,
          worktreePath,
          lock.fencingToken.toString(),
        ],
      );
      return {
        gitRefId,
        repositoryId: input.repository.id,
        taskId: input.taskId,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        mirrorPath,
        worktreePath,
        branchName,
        baseSha,
        fencingToken: lock.fencingToken,
        lock,
      };
    } catch (error) {
      await this.locks.release(lock);
      throw error;
    }
  }

  async cleanup(worktree: TaskWorktree): Promise<void> {
    await assertNoSymlinkEscape(this.worktreeRoot, worktree.worktreePath);
    const current = await this.database.query<{
      status: string;
      fencing_token: string | null;
    }>('SELECT status, fencing_token::text FROM git_refs WHERE id = $1', [
      worktree.gitRefId,
    ]);
    const record = current.rows[0];
    if (!record) throw new NotFoundError('Git reference was not found');
    if (
      record.status !== 'ACTIVE' ||
      record.fencing_token !== worktree.fencingToken.toString()
    ) {
      throw new ConflictError('Worktree cleanup lost its fencing token');
    }
    await this.git.removeWorktree(worktree.mirrorPath, worktree.worktreePath);
    await this.database.query(
      `UPDATE git_refs SET status = 'CLEANED', cleaned_at = now(),
         worktree_path = NULL, updated_at = now()
       WHERE id = $1 AND fencing_token = $2`,
      [worktree.gitRefId, worktree.fencingToken.toString()],
    );
    if (!(await this.locks.release(worktree.lock))) {
      throw new ConflictError('Repository lock was already lost');
    }
  }
}
