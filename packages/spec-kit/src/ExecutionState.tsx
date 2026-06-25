import { type ReactNode, createContext, useContext } from 'react';
import type { StatusValue } from './types.js';

/** Live execution view for a single phase, keyed by phase id/slug. */
export interface ExecutionPhaseView {
  status?: StatusValue;
  /** Most recent journal finding, shown as an inline peek under the phase. */
  latestFinding?: string;
}

/** One ordered step in the phase-driven timeline / right rail. */
export interface ExecutionRosterEntry {
  number: number;
  slug: string;
  title: string;
  status: StatusValue;
}

export interface ExecutionStateView {
  phases: Record<string, ExecutionPhaseView>;
  /** Ordered phase roster (from phase folders + live status). */
  roster?: ExecutionRosterEntry[];
  /** Derived rollup matching the roster. */
  derived?: { done: number; total: number; percent: number };
}

const EMPTY: ExecutionStateView = {
  phases: {},
  roster: [],
  derived: { done: 0, total: 0, percent: 0 },
};

const ExecutionStateContext = createContext<ExecutionStateView>(EMPTY);

/** Consumed by <Phase>/<Timeline> to overlay live status. Defaults to empty (no overlay). */
export function useExecutionState(): ExecutionStateView {
  return useContext(ExecutionStateContext);
}

export function ExecutionStateProvider({
  value,
  children,
}: {
  value: ExecutionStateView;
  children: ReactNode;
}) {
  return <ExecutionStateContext.Provider value={value}>{children}</ExecutionStateContext.Provider>;
}
