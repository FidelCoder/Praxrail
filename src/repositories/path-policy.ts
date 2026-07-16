import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export function assertManagedPath(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (
    resolvedCandidate === resolvedRoot ||
    relative.startsWith('..' + path.sep) ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Path is outside the managed root or is the root itself');
  }
  return resolvedCandidate;
}

export async function assertNoSymlinkEscape(
  root: string,
  candidate: string,
  allowMissingLeaf = false,
): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = assertManagedPath(resolvedRoot, candidate);
  const rootReal = await realpath(resolvedRoot);
  const parts = path.relative(resolvedRoot, resolvedCandidate).split(path.sep);
  let current = resolvedRoot;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error('Managed path contains a symlink');
      const currentReal = await realpath(current);
      const relative = path.relative(rootReal, currentReal);
      if (relative === '..' || relative.startsWith('..' + path.sep)) {
        throw new Error('Managed path resolves outside its root');
      }
    } catch (error) {
      const missing =
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (missing && allowMissingLeaf && index === parts.length - 1) break;
      throw error;
    }
  }
  return resolvedCandidate;
}
