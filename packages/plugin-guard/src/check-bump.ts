import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiresBump } from './changed.js';
import { compareVersions } from './versions.js';

export interface BumpInput {
  baseVersion: string;
  headVersion: string;
  changedPaths: string[];
}

export function shouldFail(input: BumpInput): { fail: boolean; reason?: string } {
  if (!requiresBump(input.changedPaths)) return { fail: false };
  if (compareVersions(input.headVersion, input.baseVersion) > 0) return { fail: false };
  return {
    fail: true,
    reason: `Behavior changed (skills/packages/commands/hooks) but plugin.json version stayed ${input.headVersion}. Bump it.`,
  };
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function versionAt(ref: string): string {
  const json = git(['show', `${ref}:.claude-plugin/plugin.json`]);
  return (JSON.parse(json) as { version: string }).version;
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const base = process.env.BASE_REF ?? 'origin/main';
  const head = process.env.HEAD_REF ?? 'HEAD';
  const changedPaths = git(['diff', '--name-only', `${base}...${head}`])
    .split('\n')
    .filter(Boolean);
  const result = shouldFail({
    baseVersion: versionAt(base),
    headVersion: versionAt(head),
    changedPaths,
  });
  if (result.fail) {
    process.stderr.write(`check-bump: ${result.reason}\n`);
    process.exit(1);
  }
  process.stdout.write('check-bump: OK\n');
}
