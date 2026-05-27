import { type ReactNode, createContext, useContext } from 'react';
import type { StatusValue } from './types.js';

/** Live execution view for a single phase, keyed by phase id/slug. */
export interface ExecutionPhaseView {
  status?: StatusValue;
  /** Most recent journal finding, shown as an inline peek under the phase. */
  latestFinding?: string;
}

export interface ExecutionStateView {
  phases: Record<string, ExecutionPhaseView>;
}

const EMPTY: ExecutionStateView = { phases: {} };

const ExecutionStateContext = createContext<ExecutionStateView>(EMPTY);

/** Consumed by <Phase> to overlay live status. Defaults to empty (no overlay). */
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
