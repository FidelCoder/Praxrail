import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

interface Boundary {
  directory: string;
  allowedPackages: ReadonlySet<string>;
}

const boundaries: Boundary[] = [
  {
    directory: path.resolve('packages/core/src'),
    allowedPackages: new Set(['zod']),
  },
  {
    directory: path.resolve('packages/client/src'),
    allowedPackages: new Set(['@praxrail/core', 'zod']),
  },
  {
    directory: path.resolve('packages/cli/src'),
    allowedPackages: new Set(['@praxrail/client', '@praxrail/core']),
  },
];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(filename);
      return entry.isFile() && entry.name.endsWith('.ts') ? [filename] : [];
    }),
  );
  return nested.flat();
}

function packageName(specifier: string): string {
  if (specifier.startsWith('@'))
    return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0] ?? specifier;
}

function validateImport(
  boundary: Boundary,
  filename: string,
  specifier: string,
): string | null {
  if (specifier.startsWith('node:')) return null;
  if (specifier.startsWith('.')) {
    const resolved = path.resolve(path.dirname(filename), specifier);
    const relative = path.relative(boundary.directory, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
      return `${filename}: relative import escapes ${boundary.directory}`;
    }
    return null;
  }
  if (!boundary.allowedPackages.has(packageName(specifier))) {
    return `${filename}: package import '${specifier}' violates its public boundary`;
  }
  return null;
}

const failures: string[] = [];
for (const boundary of boundaries) {
  for (const filename of await sourceFiles(boundary.directory)) {
    const source = ts.createSourceFile(
      filename,
      await readFile(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    source.forEachChild((node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const failure = validateImport(
          boundary,
          filename,
          node.moduleSpecifier.text,
        );
        if (failure) failures.push(failure);
      }
    });
  }
}

if (failures.length > 0) {
  throw new Error(`Package boundary violations:\n${failures.join('\n')}`);
}

process.stdout.write('Package boundaries are valid\n');
