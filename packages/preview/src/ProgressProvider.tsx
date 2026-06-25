import {
  type ExecutionRosterEntry,
  ExecutionStateProvider,
  type ExecutionStateView,
} from '@synergy/spec-kit';
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
  return last.replace(/^- \S+:\s*/, '').trim() || undefined;
}

/** Pure map: wire payload -> execution-state context value. Exported for testing. */
export function buildExecView(data: ProgressDto | null): ExecutionStateView {
  const phases: ExecutionStateView['phases'] = {};
  if (data) {
    for (const phase of data.progress.phases) {
      phases[phase.slug] = {
        status: phase.status as ExecutionStateView['phases'][string]['status'],
        latestFinding: lastFinding(data.phaseJournals[phase.slug]),
      };
    }
  }
  const roster = (data?.roster ?? []) as ExecutionRosterEntry[];
  const derived = data?.derived ?? { done: 0, total: 0, percent: 0 };
  return { phases, roster, derived };
}

const POLL_MS = 4000;

export function ProgressProvider({ session, children }: { session: string; children: ReactNode }) {
  const [data, setData] = useState<ProgressDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | undefined;

    const load = () => {
      getProgress(session)
        .then((d) => {
          if (!cancelled) setData(d);
        })
        .catch(() => {
          /* best-effort; ignore transient errors */
        });
    };

    const startPoll = () => {
      if (poll || cancelled) return;
      load();
      poll = setInterval(load, POLL_MS);
    };

    // Initial paint, then prefer the live stream; fall back to polling on error.
    load();
    let es: EventSource | undefined;
    try {
      es = new EventSource(`/api/progress/stream?session=${encodeURIComponent(session)}`);
      es.onmessage = (ev) => {
        if (cancelled) return;
        try {
          setData(JSON.parse(ev.data) as ProgressDto);
        } catch {
          /* ignore malformed frame */
        }
      };
      es.onerror = () => {
        es?.close();
        es = undefined;
        startPoll();
      };
    } catch {
      startPoll();
    }

    return () => {
      cancelled = true;
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, [session]);

  const execView = useMemo<ExecutionStateView>(() => buildExecView(data), [data]);

  return (
    <ProgressDataContext.Provider value={data}>
      <ExecutionStateProvider value={execView}>{children}</ExecutionStateProvider>
    </ProgressDataContext.Provider>
  );
}
