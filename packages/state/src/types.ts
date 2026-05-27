import type { StatusValue } from '@synergy/spec-kit';

/** Phase + overall status reuse spec-kit's StatusValue union. */
export type { StatusValue } from '@synergy/spec-kit';

export interface PhaseState {
  /** Stable phase slug (no numeric prefix), e.g. "cutover". */
  slug: string;
  status: StatusValue;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface ResumePointer {
  /** Slug of the phase a fresh agent should start with. */
  nextPhase?: string;
  /** Free-text "start here" note. */
  note?: string;
}

export interface ProgressFile {
  version: 1;
  /** Authored overall status; may differ from the derived rollup. */
  overallStatus: StatusValue;
  resume: ResumePointer;
  phases: PhaseState[];
  updatedAt?: string;
}

export interface DerivedProgress {
  done: number;
  total: number;
  /** Integer 0..100. */
  percent: number;
}
