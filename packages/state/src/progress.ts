import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { progressPath } from './paths.js';
import type { DerivedProgress, ProgressFile, StatusValue } from './types.js';

const DONE_STATUSES: ReadonlySet<StatusValue> = new Set<StatusValue>(['done', 'shipped']);

export function emptyProgress(): ProgressFile {
  return { version: 1, overallStatus: 'in-progress', resume: {}, phases: [] };
}

export function readProgress(sessionDir: string): ProgressFile {
  const file = progressPath(sessionDir);
  if (!existsSync(file)) return emptyProgress();
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as ProgressFile;
  // Defensive defaults so older/partial files don't crash consumers.
  return {
    version: 1,
    overallStatus: parsed.overallStatus ?? 'in-progress',
    resume: parsed.resume ?? {},
    phases: parsed.phases ?? [],
    updatedAt: parsed.updatedAt,
  };
}

/** Atomic JSON write: mkdir -p, write .tmp, rename over target. */
export function writeProgress(sessionDir: string, data: ProgressFile): void {
  const file = progressPath(sessionDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.progress.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export function deriveProgress(progress: ProgressFile): DerivedProgress {
  const total = progress.phases.length;
  const done = progress.phases.filter((p) => DONE_STATUSES.has(p.status)).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, percent };
}
