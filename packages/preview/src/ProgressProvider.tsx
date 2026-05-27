import { ExecutionStateProvider, type ExecutionStateView } from '@synergy/spec-kit';
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { type ProgressDto, getProgress } from './api.js';

const ProgressDataContext = createContext<ProgressDto | null>(null);
export function useProgressData(): ProgressDto | null {
  return useContext(ProgressDataContext);
}

/** Extract the last finding bullet from a phase journal for the inline peek. */
function lastFinding(journal: string | undefined): string | undefined {
  if (!journal) return undefined;
  const bullets = journal.split('\n').filter((l) => l.startsWith('- '));
  const last = bullets.at(-1);
  if (!last) return undefined;
  // Strip "- <timestamp>: " prefix.
  return last.replace(/^- \S+:\s*/, '').trim() || undefined;
}

const POLL_MS = 4000;

export function ProgressProvider({ session, children }: { session: string; children: ReactNode }) {
  const [data, setData] = useState<ProgressDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getProgress(session)
        .then((d) => {
          if (!cancelled) setData(d);
        })
        .catch(() => {
          /* progress is best-effort; ignore transient fetch errors */
        });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session]);

  const execView = useMemo<ExecutionStateView>(() => {
    const phases: ExecutionStateView['phases'] = {};
    if (data) {
      for (const phase of data.progress.phases) {
        phases[phase.slug] = {
          status: phase.status as ExecutionStateView['phases'][string]['status'],
          latestFinding: lastFinding(data.phaseJournals[phase.slug]),
        };
      }
    }
    return { phases };
  }, [data]);

  return (
    <ProgressDataContext.Provider value={data}>
      <ExecutionStateProvider value={execView}>{children}</ExecutionStateProvider>
    </ProgressDataContext.Provider>
  );
}
