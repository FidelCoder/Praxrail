import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertManagedPath, assertNoSymlinkEscape } from './path-policy.js';

export interface RepositoryInstruction {
  path: string;
  content: string;
  digest: string;
}

const MAX_INSTRUCTION_BYTES = 64 * 1024;

export async function loadRepositoryInstructions(
  root: string,
  targetDirectory: string = root,
): Promise<RepositoryInstruction[]> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget =
    path.resolve(targetDirectory) === resolvedRoot
      ? resolvedRoot
      : assertManagedPath(resolvedRoot, targetDirectory);
  if (resolvedTarget !== resolvedRoot) {
    await assertNoSymlinkEscape(resolvedRoot, resolvedTarget);
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  const directories = [resolvedRoot];
  if (relative) {
    let current = resolvedRoot;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      directories.push(current);
    }
  }

  const instructions: RepositoryInstruction[] = [];
  for (const directory of directories) {
    const instructionPath = path.join(directory, 'AGENTS.md');
    try {
      const stat = await lstat(instructionPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('AGENTS.md must be a regular file');
      }
      if (stat.size > MAX_INSTRUCTION_BYTES) {
        throw new Error('AGENTS.md exceeds the instruction size limit');
      }
      const content = await readFile(instructionPath, 'utf8');
      instructions.push({
        path: path.relative(resolvedRoot, instructionPath) || 'AGENTS.md',
        content,
        digest: createHash('sha256').update(content).digest('hex'),
      });
    } catch (error) {
      const missing =
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing) throw error;
    }
  }
  return instructions;
}
