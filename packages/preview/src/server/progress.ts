import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  type DerivedProgress,
  type ProgressFile,
  type StatusValue,
  deriveProgress,
  readGlobalJournal,
  readPhaseJournal,
  readProgress,
} from '@synergy/state';
import { listPhases } from '@synergy/validator';
import matter from 'gray-matter';
import { sendJson } from './http.js';

export interface RosterEntry {
  number: number;
  slug: string;
  title: string;
  status: StatusValue;
}

export interface ProgressResponse {
  progress: ProgressFile;
  derived: DerivedProgress;
  roster: RosterEntry[];
  phaseJournals: Record<string, string>;
  globalJournal: string | null;
}

const DONE_STATUSES: ReadonlySet<StatusValue> = new Set<StatusValue>(['done', 'shipped']);

/** Read the `title` from a phase folder's spec.mdx frontmatter; undefined if absent/unreadable. */
function readPhaseTitle(phaseDir: string): string | undefined {
  try {
    const raw = readFileSync(join(phaseDir, 'spec.mdx'), 'utf8');
    const title = matter(raw).data.title;
    return typeof title === 'string' && title.trim() ? title.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Build the ordered roster from phase folders, merging live status by slug. */
function buildRoster(sessionDir: string, progress: ProgressFile): RosterEntry[] {
  const statusBySlug = new Map<string, StatusValue>();
  for (const p of progress.phases) statusBySlug.set(p.slug, p.status);

  const roster: RosterEntry[] = [];
  for (const folder of listPhases(sessionDir)) {
    if (folder.malformed || folder.slug === undefined || folder.order === undefined) continue;
    roster.push({
      number: folder.order,
      slug: folder.slug,
      title: readPhaseTitle(folder.dir) ?? folder.slug,
      status: statusBySlug.get(folder.slug) ?? 'proposed',
    });
  }
  return roster;
}

function deriveFromRoster(roster: RosterEntry[]): DerivedProgress {
  const total = roster.length;
  const done = roster.filter((r) => DONE_STATUSES.has(r.status)).length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** Build the progress payload for a session. Guards the session name against traversal. */
export function buildProgressResponse(sessionsDir: string, session: string): ProgressResponse {
  if (!session || session.includes('/') || session.includes('\\') || session.includes('..')) {
    throw new Error(`invalid session name: ${session}`);
  }
  const sessionDir = join(sessionsDir, session);
  const progress = readProgress(sessionDir);
  const roster = buildRoster(sessionDir, progress);

  const phaseJournals: Record<string, string> = {};
  for (const phase of progress.phases) {
    const journal = readPhaseJournal(sessionDir, phase.slug);
    if (journal) phaseJournals[phase.slug] = journal;
  }

  return {
    progress,
    derived: roster.length > 0 ? deriveFromRoster(roster) : deriveProgress(progress),
    roster,
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
