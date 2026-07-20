import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const RUNTIME_OUTPUT_ROOTS = [
  'packages/cli/dist',
  'packages/review-core/dist',
  'packages/spec-kit/dist',
  'packages/state/dist',
  'packages/validator/dist',
] as const;

export const REQUIRED_RUNTIME_ARTIFACTS = [
  'packages/cli/dist/cli.js',
  'packages/cli/dist/index.js',
  'packages/cli/dist/preview-child.js',
  'packages/review-core/dist/index.js',
  'packages/review-core/dist/source-capture-worker.js',
  'packages/spec-kit/dist/index.js',
  'packages/state/dist/index.js',
  'packages/validator/dist/index.js',
] as const;

export interface ArtifactInspection {
  missing: string[];
  untracked: string[];
  drifted: string[];
  forbidden: string[];
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function sorted(paths: Iterable<string>): string[] {
  return [...paths].sort();
}

function statusPath(line: string): string {
  return line.slice(3);
}

function runtimeFiles(root: string): string[] {
  const files: string[] = [];

  function visit(relativeDirectory: string): void {
    const absoluteDirectory = resolve(root, relativeDirectory);
    if (!existsSync(absoluteDirectory)) return;

    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) visit(relativePath);
      else files.push(relativePath);
    }
  }

  for (const outputRoot of RUNTIME_OUTPUT_ROOTS) visit(outputRoot);
  return files;
}

export function inspectRuntimeArtifacts(root: string): ArtifactInspection {
  const trackedPaths = git(root, ['ls-files']).split('\n').filter(Boolean);
  const trackedPathSet = new Set(trackedPaths);
  const statusLines = git(root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...RUNTIME_OUTPUT_ROOTS,
  ])
    .split('\n')
    .filter(Boolean);

  return {
    missing: sorted(
      REQUIRED_RUNTIME_ARTIFACTS.filter((artifact) => !existsSync(resolve(root, artifact))),
    ),
    untracked: sorted(runtimeFiles(root).filter((path) => !trackedPathSet.has(path))),
    drifted: sorted(
      statusLines
        .filter((line) => !line.startsWith('?? ') && !line.startsWith('!! '))
        .map(statusPath),
    ),
    forbidden: sorted(trackedPaths.filter((path) => path.split('/').includes('node_modules'))),
  };
}

export function assertRuntimeArtifacts(root: string): void {
  const inspection = inspectRuntimeArtifacts(root);
  const failures = [
    ...inspection.missing.map((path) => `Missing required runtime artifact: ${path}`),
    ...inspection.untracked.map((path) => `Untracked runtime artifact: ${path}`),
    ...inspection.drifted.map((path) => `Drifted runtime artifact: ${path}`),
    ...inspection.forbidden.map((path) => `Forbidden tracked node_modules path: ${path}`),
  ];

  if (failures.length > 0) throw new Error(failures.join('\n'));
}
