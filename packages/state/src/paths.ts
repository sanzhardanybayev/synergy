import { join } from 'node:path';

export const STATE_DIRNAME = '.state';

/** Absolute path to a session's `.state/` directory. */
export function stateDir(sessionDir: string): string {
  return join(sessionDir, STATE_DIRNAME);
}

export function progressPath(sessionDir: string): string {
  return join(stateDir(sessionDir), 'progress.json');
}

export function phaseJournalPath(sessionDir: string, phaseId: string): string {
  return join(stateDir(sessionDir), 'phases', `${phaseId}.md`);
}

export function globalJournalPath(sessionDir: string): string {
  return join(stateDir(sessionDir), 'journal.md');
}

export function handoffPath(sessionDir: string): string {
  return join(stateDir(sessionDir), 'handoff.md');
}
