import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export { handoffPath } from './paths.js';
import { handoffPath } from './paths.js';

type NowFn = () => string;
const defaultNow: NowFn = () => new Date().toISOString();

/** Write the latest-wins handoff baton. Atomic: tmp + rename. Overwrites any prior file. */
export function writeHandoff(sessionDir: string, body: string, now: NowFn = defaultNow): void {
  const file = handoffPath(sessionDir);
  mkdirSync(dirname(file), { recursive: true });
  const stamp = now();
  const contents = `# Handoff — ${stamp}\n\n${body.trimEnd()}\n`;
  const tmp = join(dirname(file), `.handoff.${stamp.replace(/[:.]/g, '-')}.tmp`);
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, file);
}

/** Read the current handoff baton, or null when none exists. */
export function readHandoff(sessionDir: string): string | null {
  const file = handoffPath(sessionDir);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
