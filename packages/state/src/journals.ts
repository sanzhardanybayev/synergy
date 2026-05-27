import { existsSync, readFileSync } from 'node:fs';
import { globalJournalPath, phaseJournalPath } from './paths.js';

export function readPhaseJournal(sessionDir: string, phaseId: string): string | null {
  const file = phaseJournalPath(sessionDir, phaseId);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function readGlobalJournal(sessionDir: string): string | null {
  const file = globalJournalPath(sessionDir);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
