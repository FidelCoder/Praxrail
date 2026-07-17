import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ProcessLock {
  filename: string;
  release(): Promise<void>;
}

export async function acquireProcessLock(
  filename: string,
): Promise<ProcessLock> {
  const resolved = path.resolve(filename);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(resolved, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      let released = false;
      return {
        filename: resolved,
        release: async () => {
          if (released) return;
          released = true;
          const current = Number((await readFile(resolved, 'utf8')).trim());
          if (current === process.pid) await rm(resolved, { force: true });
        },
      };
    } catch (error) {
      const exists =
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EEXIST';
      if (!exists) throw error;
      const current = Number((await readFile(resolved, 'utf8')).trim());
      if (Number.isInteger(current) && current > 0 && processExists(current)) {
        throw new Error(
          `Praxrail runtime is already running as PID ${current}`,
          { cause: error },
        );
      }
      await rm(resolved, { force: true });
    }
  }
  throw new Error('Could not acquire the Praxrail runtime process lock');
}
