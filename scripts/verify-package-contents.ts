import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const packageDirectories = ['packages/core', 'packages/client', 'packages/cli'];
const forbidden = [
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)(?:test|tests|fixtures)(\/|$)/,
  /\.(?:pem|key|p12|log)$/i,
  /\.tsbuildinfo$/,
  /(^|\/)src(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /profiles\.json$/,
];

async function run(
  command: string,
  args: string[],
  cwd = process.cwd(),
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed: ${stderr.slice(0, 2_000)}`));
    });
  });
}

const output = await mkdtemp(path.join(tmpdir(), 'praxrail-packages-'));
try {
  const evidence: {
    package: string;
    artifact: string;
    sha256: string;
    files: string[];
  }[] = [];
  for (const directory of packageDirectories) {
    await run('pnpm', ['pack', '--pack-destination', output], directory);
  }
  const archives = (await readdir(output))
    .filter((filename) => filename.endsWith('.tgz'))
    .sort();
  if (archives.length !== packageDirectories.length) {
    throw new Error('Expected one archive for every public package');
  }
  for (const archive of archives) {
    const filename = path.join(output, archive);
    const files = (await run('tar', ['-tzf', filename]))
      .trim()
      .split('\n')
      .filter(Boolean);
    const unsafe = files.filter((entry) =>
      forbidden.some((pattern) => pattern.test(entry)),
    );
    if (unsafe.length > 0) {
      throw new Error(
        `Forbidden package content in ${archive}: ${unsafe.join(', ')}`,
      );
    }
    const content = await readFile(filename);
    const manifest = JSON.parse(
      await run('tar', ['-xOf', filename, 'package/package.json']),
    ) as { name?: unknown; version?: unknown };
    if (typeof manifest.name !== 'string') {
      throw new Error(`Package manifest in ${archive} is missing a name`);
    }
    if (typeof manifest.version !== 'string') {
      throw new Error(`Package manifest in ${archive} is missing a version`);
    }
    if (
      manifest.name === 'praxrail' &&
      !files.includes('package/runtime/index.js')
    ) {
      throw new Error(
        'praxrail package is missing the managed runtime entrypoint',
      );
    }
    evidence.push({
      package: manifest.name,
      artifact: archive,
      sha256: createHash('sha256').update(content).digest('hex'),
      files,
    });
  }
  process.stdout.write(`${JSON.stringify({ version: '0.3.7', evidence })}\n`);
} finally {
  await rm(output, { recursive: true, force: true });
}
