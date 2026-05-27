import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  deriveProgress,
  readGlobalJournal,
  readPhaseJournal,
  readProgress,
  type DerivedProgress,
  type ProgressFile,
} from '@synergy/state';
import { sendJson } from './http.js';

export interface ProgressResponse {
  progress: ProgressFile;
  derived: DerivedProgress;
  phaseJournals: Record<string, string>;
  globalJournal: string | null;
}

/** Build the progress payload for a session. Guards the session name against traversal. */
export function buildProgressResponse(sessionsDir: string, session: string): ProgressResponse {
  if (!session || session.includes('/') || session.includes('\\') || session.includes('..')) {
    throw new Error(`invalid session name: ${session}`);
  }
  const sessionDir = join(sessionsDir, session);
  const progress = readProgress(sessionDir);
  const phaseJournals: Record<string, string> = {};
  for (const phase of progress.phases) {
    const journal = readPhaseJournal(sessionDir, phase.slug);
    if (journal) phaseJournals[phase.slug] = journal;
  }
  return {
    progress,
    derived: deriveProgress(progress),
    phaseJournals,
    globalJournal: readGlobalJournal(sessionDir),
  };
}

/** GET /api/progress?session=<name> */
export function handleProgress(
  req: IncomingMessage,
  res: ServerResponse,
  sessionsDir: string,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const session = url.searchParams.get('session');
  if (!session) {
    sendJson(res, 400, { error: 'missing session' });
    return;
  }
  try {
    sendJson(res, 200, buildProgressResponse(sessionsDir, session));
  } catch (err) {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
