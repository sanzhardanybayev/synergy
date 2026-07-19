import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { green } from 'kleur/colors';
import { resolveProjectPaths } from './paths.js';

const GITIGNORE_ENTRIES = [
  'preview.runtime.json',
  'preview.runtime.json.quarantine.*',
  '.preview.runtime.json.*.tmp',
  'preview.runtime.json.mutation.lock',
  'preview.start.lock',
  'preview.start.lock.quarantine.*',
  'preview.start.lock.owner.tmp.*',
  'preview.pid',
  'preview.log',
  'active-session',
  'review-state.json',
  'reviews/',
  'active-review.json',
  '',
];

export function ensureSynergyGitignore(root: string = process.cwd()): string {
  const paths = resolveProjectPaths(root);
  mkdirSync(paths.synergyDir, { recursive: true });
  const gitignorePath = join(paths.synergyDir, '.gitignore');
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const present = new Set(current.split(/\r?\n/u));
  const missing = GITIGNORE_ENTRIES.filter((entry) => entry.length > 0 && !present.has(entry));
  if (missing.length === 0) return gitignorePath;
  const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  appendFileSync(gitignorePath, `${separator}${missing.join('\n')}\n`);
  return gitignorePath;
}

export function initProject(root: string = process.cwd()): { synergyDir: string } {
  const paths = resolveProjectPaths(root);
  mkdirSync(paths.sessionsDir, { recursive: true });
  ensureSynergyGitignore(paths.root);
  process.stdout.write(`${green('✓')} Initialized .synergy/ in ${paths.root}\n`);
  return { synergyDir: paths.synergyDir };
}
