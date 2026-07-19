import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { green } from 'kleur/colors';
import { resolveProjectPaths } from './paths.js';

const GITIGNORE_ENTRIES = [
  'preview.runtime.json',
  'preview.start.lock',
  'preview.pid',
  'preview.log',
  'active-session',
  'review-state.json',
  'reviews/',
  'active-review.json',
  '',
];

export function initProject(root: string = process.cwd()): { synergyDir: string } {
  const paths = resolveProjectPaths(root);
  mkdirSync(paths.sessionsDir, { recursive: true });
  writeFileSync(join(paths.synergyDir, '.gitignore'), `${GITIGNORE_ENTRIES.join('\n')}`);
  process.stdout.write(`${green('✓')} Initialized .synergy/ in ${paths.root}\n`);
  return { synergyDir: paths.synergyDir };
}
