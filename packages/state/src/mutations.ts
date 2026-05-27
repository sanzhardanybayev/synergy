import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { globalJournalPath, phaseJournalPath } from './paths.js';
import { readProgress, writeProgress } from './progress.js';
import type { PhaseState, ResumePointer, StatusValue } from './types.js';

type NowFn = () => string;
const defaultNow: NowFn = () => new Date().toISOString();

const DONE = new Set<StatusValue>(['done', 'shipped']);

function appendTo(absPath: string, text: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  appendFileSync(absPath, text, 'utf8');
}

export interface SetPhaseOptions {
  /** Optional boundary note appended to the phase journal. */
  note?: string;
  now?: NowFn;
}

/** Set a phase's status, stamping start/complete timestamps and (optionally) a boundary note. */
export function setPhaseStatus(
  sessionDir: string,
  phaseId: string,
  status: StatusValue,
  opts: SetPhaseOptions = {},
): void {
  const now = (opts.now ?? defaultNow)();
  const progress = readProgress(sessionDir);
  let phase: PhaseState | undefined = progress.phases.find((p) => p.slug === phaseId);
  if (!phase) {
    phase = { slug: phaseId, status };
    progress.phases.push(phase);
  }
  if (status === 'in-progress' && !phase.startedAt) phase.startedAt = now;
  if (DONE.has(status)) phase.completedAt = now;
  phase.status = status;
  phase.updatedAt = now;
  progress.updatedAt = now;
  writeProgress(sessionDir, progress);

  if (opts.note) {
    appendTo(phaseJournalPath(sessionDir, phaseId), `\n## ${status} — ${now}\n${opts.note}\n`);
  }
}

export type FindingTarget = { phase: string } | { global: true };

/** Append an ad-hoc finding to a phase journal or the global journal. */
export function appendFinding(
  sessionDir: string,
  target: FindingTarget,
  text: string,
  now: NowFn = defaultNow,
): void {
  const stamp = now();
  const path =
    'global' in target ? globalJournalPath(sessionDir) : phaseJournalPath(sessionDir, target.phase);
  appendTo(path, `- ${stamp}: ${text}\n`);
}

/** Set the resume pointer a fresh agent reads first. */
export function setResume(
  sessionDir: string,
  resume: ResumePointer,
  now: NowFn = defaultNow,
): void {
  const progress = readProgress(sessionDir);
  progress.resume = resume;
  progress.updatedAt = now();
  writeProgress(sessionDir, progress);
}
