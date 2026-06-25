# Phase-driven Live Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the overview `<Timeline>` a live, phase-driven tracker — steps are the phases (number + title + live status) with a derived progress bar — sharing one source of truth with the right-rail progress drawer and updating near-instantly via SSE.

**Architecture:** A new ordered **roster** (built server-side from `phases/<NN>-<slug>/` folders + live `.state/progress.json` status) is returned by `/api/progress` and pushed by a new `/api/progress/stream` SSE endpoint. `ProgressProvider` feeds the roster + derived totals through the existing execution-state React context. `<Timeline>` (when given no `milestones`) and `ProgressDrawer` both render from that roster, so they never diverge. `.mdx` and `progress.json` on-disk formats are unchanged.

**Tech Stack:** TypeScript (strict), pnpm workspaces, Vite + React + MDX, vitest 2.1.5, `@testing-library/react`, `gray-matter` (already a preview dep), Node `fs.watch` for SSE.

## Global Constraints

- pnpm only (never npm/yarn); TypeScript strict mode on.
- Preview server port is fixed at **4321**; do not change it.
- `packages/preview` stays Vite + React + MDX — no Next.js/Astro, no new heavy deps. Reuse `gray-matter` (already used in `src/server/feedback.ts`).
- One package per concern — do not let preview logic leak into spec-kit or vice versa. The roster is built in the preview **server**; spec-kit only consumes context.
- Prefer spec-kit components over raw markdown.
- Biome runs on pre-commit (lefthook). No explicit `any`, no `delete`, use literal keys — match existing style.
- Test runner: `pnpm --filter <pkg> exec vitest run <file>` (e.g. `pnpm --filter @synergy/preview exec vitest run tests/server/progress.test.ts`).

---

### Task 1: Roster builder in the progress endpoint

Build the ordered phase roster (folders + merged live status) and source `derived` from it when phase folders exist; fall back to the legacy touched-phase derivation when there are none.

**Files:**
- Modify: `packages/validator/src/index.ts` (export `listPhases`, `PhaseFolder`)
- Modify: `packages/preview/src/server/progress.ts`
- Test: `packages/preview/tests/server/progress.test.ts`

**Interfaces:**
- Consumes: `listPhases(sessionDir): PhaseFolder[]` from `@synergy/validator` (already implemented in `packages/validator/src/phase.ts`; fields `folderName`, `dir`, `order`, `slug`, `malformed`); `readProgress`, `deriveProgress` from `@synergy/state`; `matter` from `gray-matter`.
- Produces: `RosterEntry { number: number; slug: string; title: string; status: StatusValue }` and `ProgressResponse.roster: RosterEntry[]` (empty when no phase folders). `ProgressResponse.derived` is roster-based when roster is non-empty, else legacy.

- [ ] **Step 1: Export the phase enumerator from the validator**

In `packages/validator/src/index.ts`, add:

```ts
export { listPhases } from './phase.js';
export type { PhaseFolder } from './phase.js';
```

- [ ] **Step 2: Write the failing tests** (append to `packages/preview/tests/server/progress.test.ts`)

```ts
import { mkdirSync, writeFileSync } from 'node:fs';

function writePhaseFolder(sessionsDir: string, session: string, nn: string, slug: string, title: string | null) {
  const dir = join(sessionsDir, session, 'phases', `${nn}-${slug}`);
  mkdirSync(dir, { recursive: true });
  const fm = title === null ? '---\norder: 1\n---\n' : `---\ntitle: '${title}'\norder: 1\n---\n`;
  writeFileSync(join(dir, 'spec.mdx'), `${fm}\n# ${slug}\n`, 'utf8');
}

describe('buildProgressResponse — roster', () => {
  it('builds an ordered roster from phase folders, merging live status', () => {
    const sessionDir = join(sessionsDir, SESSION);
    writePhaseFolder(sessionsDir, SESSION, '01', 'storage', 'Storage layer');
    writePhaseFolder(sessionsDir, SESSION, '02', 'cutover', 'Cutover to new store');
    writePhaseFolder(sessionsDir, SESSION, '03', 'rollout', 'Gradual rollout');
    setPhaseStatus(sessionDir, 'storage', 'done');
    setPhaseStatus(sessionDir, 'cutover', 'in-progress');

    const res = buildProgressResponse(sessionsDir, SESSION);
    expect(res.roster).toEqual([
      { number: 1, slug: 'storage', title: 'Storage layer', status: 'done' },
      { number: 2, slug: 'cutover', title: 'Cutover to new store', status: 'in-progress' },
      { number: 3, slug: 'rollout', title: 'Gradual rollout', status: 'proposed' },
    ]);
    expect(res.derived).toEqual({ done: 1, total: 3, percent: 33 });
  });

  it('falls back to the slug when a phase spec has no title', () => {
    writePhaseFolder(sessionsDir, SESSION, '01', 'storage', null);
    const res = buildProgressResponse(sessionsDir, SESSION);
    expect(res.roster[0]).toEqual({ number: 1, slug: 'storage', title: 'storage', status: 'proposed' });
  });

  it('returns an empty roster and legacy derived when there are no phase folders', () => {
    const sessionDir = join(sessionsDir, SESSION);
    setPhaseStatus(sessionDir, 'storage', 'done');
    const res = buildProgressResponse(sessionsDir, SESSION);
    expect(res.roster).toEqual([]);
    expect(res.derived).toEqual({ done: 1, total: 1, percent: 100 });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @synergy/preview exec vitest run tests/server/progress.test.ts`
Expected: FAIL — `res.roster` is undefined.

- [ ] **Step 4: Implement the roster in `packages/preview/src/server/progress.ts`**

Add imports and a title reader, build the roster, and source `derived` from it. Replace the file's body with:

```ts
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
```

> Note: confirm `StatusValue` is re-exported from `@synergy/state` (it re-exports from `@synergy/spec-kit` in `packages/state/src/types.ts`). If the named import fails, import it from `@synergy/spec-kit` instead.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @synergy/preview exec vitest run tests/server/progress.test.ts`
Expected: PASS (new roster tests + the original `done:1,total:2` test still green — it creates no folders, so it stays on the legacy path).

- [ ] **Step 6: Commit**

```bash
git add packages/validator/src/index.ts packages/preview/src/server/progress.ts packages/preview/tests/server/progress.test.ts
git commit -m "feat(preview): build phase roster from folders + live status in progress endpoint"
```

---

### Task 2: Carry roster + derived through the API client and execution-state context

Add `roster`/`derived` to the wire type and to the React context so consumers can read them.

**Files:**
- Modify: `packages/preview/src/api.ts` (`ProgressDto`)
- Modify: `packages/spec-kit/src/ExecutionState.tsx`
- Modify: `packages/spec-kit/src/components/index.ts` (export new type)
- Test: `packages/spec-kit/tests/ExecutionState.test.tsx` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ExecutionRosterEntry { number: number; slug: string; title: string; status: StatusValue }`; `ExecutionStateView` gains optional `roster?: ExecutionRosterEntry[]` and `derived?: { done: number; total: number; percent: number }`. `ProgressDto.roster: { number; slug; title; status }[]`.

- [ ] **Step 1: Write the failing test** (`packages/spec-kit/tests/ExecutionState.test.tsx`)

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExecutionStateProvider, useExecutionState } from '../src/ExecutionState.js';

function Probe() {
  const { roster, derived } = useExecutionState();
  return <div data-testid="probe">{roster?.length ?? -1}:{derived?.percent ?? -1}</div>;
}

describe('ExecutionState context', () => {
  it('defaults roster to empty and derived to zero', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('0:0');
  });

  it('passes roster and derived through the provider', () => {
    render(
      <ExecutionStateProvider
        value={{
          phases: {},
          roster: [{ number: 1, slug: 'storage', title: 'Storage layer', status: 'done' }],
          derived: { done: 1, total: 2, percent: 50 },
        }}
      >
        <Probe />
      </ExecutionStateProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('1:50');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @synergy/spec-kit exec vitest run tests/ExecutionState.test.tsx`
Expected: FAIL — `roster`/`derived` are not on `ExecutionStateView`.

- [ ] **Step 3: Extend the context** — edit `packages/spec-kit/src/ExecutionState.tsx`

```tsx
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

const EMPTY: ExecutionStateView = { phases: {}, roster: [], derived: { done: 0, total: 0, percent: 0 } };

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
```

- [ ] **Step 4: Export the new type** — in `packages/spec-kit/src/components/index.ts`, update the ExecutionState type export line to:

```ts
export type { ExecutionStateView, ExecutionPhaseView, ExecutionRosterEntry } from '../ExecutionState.js';
```

- [ ] **Step 5: Add `roster` to `ProgressDto`** — in `packages/preview/src/api.ts`, inside the `ProgressDto` interface, add the field after `phases`/`derived`:

```ts
  roster: { number: number; slug: string; title: string; status: string }[];
```

(Place it as a top-level field of `ProgressDto`, alongside `derived` and `phaseJournals`.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @synergy/spec-kit exec vitest run tests/ExecutionState.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/spec-kit/src/ExecutionState.tsx packages/spec-kit/src/components/index.ts packages/preview/src/api.ts packages/spec-kit/tests/ExecutionState.test.tsx
git commit -m "feat(spec-kit): carry roster + derived through execution-state context"
```

---

### Task 3: ProgressProvider feeds roster + derived (extracted, testable mapping)

Map `ProgressDto` → `ExecutionStateView` including roster/derived via a pure exported helper, and wire it into the provider.

**Files:**
- Modify: `packages/preview/src/ProgressProvider.tsx`
- Test: `packages/preview/tests/ProgressProvider.test.tsx` (new)

**Interfaces:**
- Consumes: `ProgressDto` (now with `roster`).
- Produces: `buildExecView(data: ProgressDto | null): ExecutionStateView` (exported for testing).

- [ ] **Step 1: Write the failing test** (`packages/preview/tests/ProgressProvider.test.tsx`)

```tsx
import { describe, expect, it } from 'vitest';
import { buildExecView } from '../src/ProgressProvider.js';
import type { ProgressDto } from '../src/api.js';

const dto: ProgressDto = {
  progress: { version: 1, overallStatus: 'in-progress', resume: {}, phases: [{ slug: 'storage', status: 'done' }] },
  derived: { done: 1, total: 2, percent: 50 },
  roster: [
    { number: 1, slug: 'storage', title: 'Storage layer', status: 'done' },
    { number: 2, slug: 'cutover', title: 'Cutover', status: 'proposed' },
  ],
  phaseJournals: {},
  globalJournal: null,
};

describe('buildExecView', () => {
  it('maps roster and derived onto the execution view', () => {
    const view = buildExecView(dto);
    expect(view.derived).toEqual({ done: 1, total: 2, percent: 50 });
    expect(view.roster).toEqual(dto.roster);
    expect(view.phases.storage?.status).toBe('done');
  });

  it('returns empty roster/derived for null data', () => {
    const view = buildExecView(null);
    expect(view.roster).toEqual([]);
    expect(view.derived).toEqual({ done: 0, total: 0, percent: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @synergy/preview exec vitest run tests/ProgressProvider.test.tsx`
Expected: FAIL — `buildExecView` is not exported.

- [ ] **Step 3: Extract `buildExecView` and use SSE with poll fallback** — edit `packages/preview/src/ProgressProvider.tsx`

```tsx
import {
  ExecutionStateProvider,
  type ExecutionStateView,
  type ExecutionRosterEntry,
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @synergy/preview exec vitest run tests/ProgressProvider.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/preview/src/ProgressProvider.tsx packages/preview/tests/ProgressProvider.test.tsx
git commit -m "feat(preview): subscribe to progress SSE with poll fallback; map roster into context"
```

---

### Task 4: SSE endpoint `/api/progress/stream`

Stream the progress payload and push a fresh frame whenever the session's `.state/` or `phases/` change.

**Files:**
- Create: `packages/preview/src/server/progress-stream.ts`
- Modify: `packages/preview/vite-plugin-edit.ts` (import + route)
- Test: `packages/preview/tests/server/progress-stream.test.ts` (new)

**Interfaces:**
- Consumes: `buildProgressResponse` from `./progress.js`.
- Produces: `formatSseFrame(payload: unknown): string` (exported helper, returns `data: <json>\n\n`); `handleProgressStream(req, res, sessionsDir)`.

- [ ] **Step 1: Write the failing test** (`packages/preview/tests/server/progress-stream.test.ts`)

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setPhaseStatus } from '@synergy/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatSseFrame, initialFrame } from '../../src/server/progress-stream.js';

let sessionsDir: string;
beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'synergy-sse-'));
});
afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe('progress-stream framing', () => {
  it('formats an SSE data frame terminated by a blank line', () => {
    const frame = formatSseFrame({ a: 1 });
    expect(frame).toBe('data: {"a":1}\n\n');
  });

  it('initialFrame embeds the current progress payload', () => {
    setPhaseStatus(join(sessionsDir, 'demo'), 'storage', 'done');
    const frame = initialFrame(sessionsDir, 'demo');
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(JSON.parse(frame.slice('data: '.length).trim()).derived).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @synergy/preview exec vitest run tests/server/progress-stream.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the SSE handler** (`packages/preview/src/server/progress-stream.ts`)

```ts
import { type FSWatcher, watch } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { buildProgressResponse } from './progress.js';

export function formatSseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Build the initial SSE frame for a session's current progress. */
export function initialFrame(sessionsDir: string, session: string): string {
  return formatSseFrame(buildProgressResponse(sessionsDir, session));
}

const DEBOUNCE_MS = 80;

/**
 * GET /api/progress/stream?session=<name>
 * Sends the current payload immediately, then a fresh payload whenever the
 * session directory changes (debounced). Watches recursively where supported;
 * the client falls back to polling if the stream errors.
 */
export function handleProgressStream(
  req: IncomingMessage,
  res: ServerResponse,
  sessionsDir: string,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const session = url.searchParams.get('session');
  if (!session || session.includes('/') || session.includes('\\') || session.includes('..')) {
    res.statusCode = 400;
    res.end('invalid session');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = () => {
    try {
      res.write(formatSseFrame(buildProgressResponse(sessionsDir, session)));
    } catch {
      /* transient: a half-written file mid-rebuild; next event will catch up */
    }
  };

  send(); // initial paint

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(send, DEBOUNCE_MS);
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(join(sessionsDir, session), { recursive: true }, (_event, filename) => {
      const name = filename?.toString() ?? '';
      if (name.includes('.state') || name.includes('phases')) schedule();
    });
  } catch {
    /* recursive watch unsupported here; client poll fallback covers it */
  }

  req.on('close', () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
    res.end();
  });
}
```

- [ ] **Step 4: Register the route** — in `packages/preview/vite-plugin-edit.ts`:

Add the import near the other server imports:

```ts
import { handleProgressStream } from './src/server/progress-stream.js';
```

Then, immediately **before** the existing `GET /api/progress` block (so the more specific path matches first), add:

```ts
          // GET /api/progress/stream (SSE)
          if (method === 'GET' && pathname === '/api/progress/stream') {
            handleProgressStream(req, res, sessionsDir);
            return;
          }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @synergy/preview exec vitest run tests/server/progress-stream.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/preview/src/server/progress-stream.ts packages/preview/vite-plugin-edit.ts packages/preview/tests/server/progress-stream.test.ts
git commit -m "feat(preview): add /api/progress/stream SSE endpoint watching .state + phases"
```

---

### Task 5: `<Timeline>` phase-driven render

When no `milestones` are provided, render the phase roster (bar + numbered steps with live status). Keep the legacy milestone form working.

**Files:**
- Modify: `packages/spec-kit/src/components/Timeline.tsx`
- Modify: `packages/spec-kit/src/styles.css`
- Test: `packages/spec-kit/tests/Timeline.test.tsx` (new)

**Interfaces:**
- Consumes: `useExecutionState()` → `{ roster, derived }`.
- Produces: `<Timeline />` (phase-driven) and `<Timeline milestones={...} />` (legacy). `TimelineProps.milestones` becomes optional.

- [ ] **Step 1: Write the failing tests** (`packages/spec-kit/tests/Timeline.test.tsx`)

```tsx
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ExecutionStateProvider, type ExecutionRosterEntry } from '../src/ExecutionState.js';
import { Timeline } from '../src/components/Timeline.js';

function withState(
  node: ReactNode,
  roster: ExecutionRosterEntry[],
  derived = { done: 0, total: roster.length, percent: 0 },
) {
  return render(
    <ExecutionStateProvider value={{ phases: {}, roster, derived }}>{node}</ExecutionStateProvider>,
  );
}

describe('Timeline — phase-driven', () => {
  it('renders a step per roster entry with number + title + status', () => {
    withState(<Timeline />, [
      { number: 1, slug: 'storage', title: 'Storage layer', status: 'done' },
      { number: 2, slug: 'cutover', title: 'Cutover to new store', status: 'in-progress' },
    ], { done: 1, total: 2, percent: 50 });
    expect(screen.getByText('Storage layer')).toBeTruthy();
    expect(screen.getByText('Cutover to new store')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByTestId('timeline-bar-fill').style.width).toBe('50%');
  });

  it('renders nothing when the roster is empty and no milestones are given', () => {
    const { container } = withState(<Timeline />, []);
    expect(container.querySelector('.sk-timeline')).toBeNull();
  });

  it('still renders the legacy milestone form', () => {
    render(<Timeline milestones={[{ label: 'Plan approved', status: 'proposed' }]} />);
    expect(screen.getByText('Plan approved')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @synergy/spec-kit exec vitest run tests/Timeline.test.tsx`
Expected: FAIL — phase-driven branch + `timeline-bar-fill` testid do not exist.

- [ ] **Step 3: Implement the dual-mode Timeline** (`packages/spec-kit/src/components/Timeline.tsx`)

```tsx
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useExecutionState } from '../ExecutionState.js';
import { Status } from './Status.js';
import type { StatusValue } from '../types.js';

export interface TimelineMilestone {
  label: string;
  /** ISO date or human string. */
  when?: string;
  status?: StatusValue;
  description?: string;
}

export interface TimelineProps {
  /** Legacy static milestones. Omit for the phase-driven live form. */
  milestones?: TimelineMilestone[];
  /** Optional caption above the timeline. */
  caption?: string;
  children?: ReactNode;
}

export function Timeline({ milestones, caption, children }: TimelineProps) {
  const { roster = [], derived } = useExecutionState();

  // Phase-driven form: no authored milestones -> render the live roster.
  if (!milestones) {
    if (roster.length === 0) return null;
    const percent = derived?.percent ?? 0;
    return (
      <figure className="sk-timeline sk-timeline--phases">
        {caption ? <figcaption className="sk-timeline__caption">{caption}</figcaption> : null}
        <div className="sk-timeline__bar" aria-hidden="true">
          <div
            className="sk-timeline__fill"
            data-testid="timeline-bar-fill"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="sk-timeline__rollup">
          {derived?.done ?? 0} / {derived?.total ?? roster.length} phases ({percent}%)
        </p>
        <ol className="sk-timeline__steps">
          {roster.map((step) => (
            <li
              key={step.slug}
              className={clsx('sk-timeline__step', `sk-timeline__step--${step.status}`)}
            >
              <span className="sk-timeline__step-num">{step.number}</span>
              <span className="sk-timeline__step-title">{step.title}</span>
              <Status value={step.status} />
            </li>
          ))}
        </ol>
        {children}
      </figure>
    );
  }

  // Legacy static milestone form.
  return (
    <figure className="sk-timeline">
      {caption ? <figcaption className="sk-timeline__caption">{caption}</figcaption> : null}
      <ol className="sk-timeline__list">
        {milestones.map((m, i) => (
          <li
            key={`${m.label}-${i}`}
            className={clsx('sk-timeline__item', m.status && `sk-timeline__item--${m.status}`)}
          >
            <span className="sk-timeline__marker" aria-hidden />
            <div className="sk-timeline__content">
              <div className="sk-timeline__head">
                <strong className="sk-timeline__label">{m.label}</strong>
                {m.when ? <span className="sk-timeline__when">{m.when}</span> : null}
              </div>
              {m.description ? <p className="sk-timeline__description">{m.description}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      {children}
    </figure>
  );
}
```

- [ ] **Step 4: Add styles** — append to `packages/spec-kit/src/styles.css`

```css
/* Phase-driven timeline (live roster) */
.sk-timeline__bar {
  height: 8px;
  border-radius: 999px;
  background: var(--sk-border, #e2e8f0);
  overflow: hidden;
}
.sk-timeline__fill {
  height: 100%;
  background: var(--sk-accent, #3b82f6);
  transition: width 240ms ease;
}
.sk-timeline__rollup {
  margin: 6px 0 12px;
  font-size: 0.85rem;
  color: var(--sk-muted, #64748b);
}
.sk-timeline__steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sk-timeline__step {
  display: grid;
  grid-template-columns: 1.6rem 1fr auto;
  align-items: center;
  gap: 10px;
}
.sk-timeline__step-num {
  width: 1.6rem;
  height: 1.6rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--sk-border, #e2e8f0);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}
.sk-timeline__step--done .sk-timeline__step-num,
.sk-timeline__step--shipped .sk-timeline__step-num {
  background: var(--sk-accent, #3b82f6);
  color: #fff;
}
.sk-timeline__step-title {
  font-weight: 500;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @synergy/spec-kit exec vitest run tests/Timeline.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the full spec-kit suite (no regressions in Phase/Status/etc.)**

Run: `pnpm --filter @synergy/spec-kit test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/spec-kit/src/components/Timeline.tsx packages/spec-kit/src/styles.css packages/spec-kit/tests/Timeline.test.tsx
git commit -m "feat(spec-kit): phase-driven live Timeline (bar + numbered steps) with legacy fallback"
```

---

### Task 6: Right rail renders from the roster

Make `ProgressDrawer` show the full ordered roster (number + title + live status) when present, so it matches the timeline; fall back to the legacy phase list when there is no roster.

**Files:**
- Modify: `packages/preview/src/ProgressDrawer.tsx`
- Test: `packages/preview/tests/ProgressDrawer.test.tsx` (new)

**Interfaces:**
- Consumes: `ProgressDto` (`roster`, `derived`, `phaseJournals`).

- [ ] **Step 1: Write the failing test** (`packages/preview/tests/ProgressDrawer.test.tsx`)

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgressDrawer } from '../src/ProgressDrawer.js';
import type { ProgressDto } from '../src/api.js';

const data: ProgressDto = {
  progress: { version: 1, overallStatus: 'in-progress', resume: {}, phases: [{ slug: 'storage', status: 'done' }] },
  derived: { done: 1, total: 2, percent: 50 },
  roster: [
    { number: 1, slug: 'storage', title: 'Storage layer', status: 'done' },
    { number: 2, slug: 'cutover', title: 'Cutover', status: 'proposed' },
  ],
  phaseJournals: {},
  globalJournal: null,
};

describe('ProgressDrawer', () => {
  it('renders roster titles and the derived rollup', () => {
    render(<ProgressDrawer open data={data} onClose={() => {}} />);
    expect(screen.getByText('Storage layer')).toBeTruthy();
    expect(screen.getByText('Cutover')).toBeTruthy();
    expect(screen.getByText(/1 \/ 2 phases done \(50%\)/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @synergy/preview exec vitest run tests/ProgressDrawer.test.tsx`
Expected: FAIL — drawer renders slugs, not titles.

- [ ] **Step 3: Render the roster** — in `packages/preview/src/ProgressDrawer.tsx`, replace the `const phases = ...` line and the `<ul className="progress-phases">` block.

Change the derived/phases extraction near the top of the component body:

```tsx
  const derived = data?.derived ?? { done: 0, total: 0, percent: 0 };
  const roster = data?.roster ?? [];
  const legacyPhases = data?.progress.phases ?? [];
  const resume = data?.progress.resume ?? {};
  const rows =
    roster.length > 0
      ? roster.map((r) => ({ slug: r.slug, status: r.status, label: r.title }))
      : legacyPhases.map((p) => ({ slug: p.slug, status: p.status, label: p.slug }));
```

Then replace the phases `<ul>` with:

```tsx
          <ul className="progress-phases">
            {rows.map((p) => (
              <li key={p.slug} className="progress-phases__item">
                <span className={`sk-status sk-status--${p.status}`} data-status={p.status}>
                  <span className="sk-status__dot" aria-hidden />
                  {p.status}
                </span>
                <span className="progress-phases__slug">{p.label}</span>
                {data?.phaseJournals[p.slug] ? (
                  <details className="progress-phases__journal">
                    <summary>journal</summary>
                    <pre>{data.phaseJournals[p.slug]}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @synergy/preview exec vitest run tests/ProgressDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/preview/src/ProgressDrawer.tsx packages/preview/tests/ProgressDrawer.test.tsx
git commit -m "feat(preview): right rail renders the full phase roster with titles"
```

---

### Task 7: Validator warns on phase `spec.mdx` missing a `title`

The timeline label reads the phase title; warn when it is absent so authors fix it.

**Files:**
- Modify: `packages/validator/src/phase.ts` (`validatePhaseStructure`)
- Test: `packages/validator/tests/phase.test.ts` (add cases; create file if absent)

**Interfaces:**
- Consumes: phase folder `spec.mdx` frontmatter.
- Produces: a `warning` `ValidationIssue` when a well-formed phase folder's `spec.mdx` has no frontmatter `title`.

- [ ] **Step 1: Write the failing test** — add to `packages/validator/tests/phase.test.ts`

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validatePhaseStructure } from '../src/phase.js';

let sessionDir: string;
beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'synergy-phase-'));
});
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

function phase(nn: string, slug: string, body: string) {
  const dir = join(sessionDir, 'phases', `${nn}-${slug}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.mdx'), body, 'utf8');
  writeFileSync(join(dir, 'orchestrator.md'), '# orch\n', 'utf8');
}

describe('validatePhaseStructure — title warning', () => {
  it('warns when a phase spec.mdx has no frontmatter title', () => {
    phase('01', 'storage', '---\norder: 1\n---\n# storage\n');
    const issues = validatePhaseStructure(sessionDir);
    expect(issues.some((i) => i.severity === 'warning' && /missing a `title`/.test(i.message))).toBe(true);
  });

  it('does not warn when a title is present', () => {
    phase('01', 'storage', "---\ntitle: 'Storage layer'\norder: 1\n---\n# storage\n");
    const issues = validatePhaseStructure(sessionDir);
    expect(issues.some((i) => /missing a `title`/.test(i.message))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @synergy/validator exec vitest run tests/phase.test.ts`
Expected: FAIL — no title warning emitted.

- [ ] **Step 3: Add the title check** — in `packages/validator/src/phase.ts`, add a frontmatter title reader near the top (after the imports):

```ts
import { readFileSync } from 'node:fs';

/** True when the file's leading frontmatter block declares a non-empty `title:`. */
function hasFrontmatterTitle(specPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(specPath, 'utf8');
  } catch {
    return false;
  }
  const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!fm) return false;
  return /^title:\s*\S/m.test(fm[1]!);
}
```

Then, inside `validatePhaseStructure`, in the per-folder loop, just after the existing `spec.mdx` existence check, add:

```ts
    const specPath = join(phase.dir, 'spec.mdx');
    if (existsSync(specPath) && !hasFrontmatterTitle(specPath)) {
      issues.push({
        file: specPath,
        severity: 'warning',
        message: `Phase folder "${phase.folderName}" spec.mdx is missing a \`title\` (needed for the live timeline label)`,
      });
    }
```

(Place it within the `for (const phase of phases)` loop, after the `if (!existsSync(join(phase.dir, 'spec.mdx')))` block. Note `existsSync` and `join` are already imported in this file.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @synergy/validator exec vitest run tests/phase.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full validator suite (no regressions)**

Run: `pnpm --filter @synergy/validator test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/validator/src/phase.ts packages/validator/tests/phase.test.ts
git commit -m "feat(validator): warn when a phase spec.mdx is missing a title"
```

---

### Task 8: Templates, convention docs, and example session

Switch the scaffolded timeline to the phase-driven form, document the live-bound convention, and update the dogfood example so the preview demonstrates the live timeline.

**Files:**
- Modify: `skills/create-spec/templates/overview-full.mdx`
- Modify: `skills/create-spec/templates/implementation.mdx`
- Modify: `CLAUDE.md`
- Modify: `skills/spec-authoring/SKILL.md`
- Modify: `examples/.synergy/sessions/refactor-auth/00-overview.mdx`

- [ ] **Step 1: Phase-driven timeline in the overview template** — in `skills/create-spec/templates/overview-full.mdx`, replace the entire `## Timeline` block (the `<Timeline milestones={[ ... ]} />`) with:

```mdx
## Timeline

The timeline below is the phase roster — it fills in live as phases are
implemented (status comes from execution state, not the doc). No milestones to
hand-maintain.

<Timeline />
```

- [ ] **Step 2: Same in the implementation template** — in `skills/create-spec/templates/implementation.mdx`, replace its `<Timeline milestones={[ ... ]} />` block under `## Timeline` with `<Timeline />`.

- [ ] **Step 3: Document the live-bound convention** — in `CLAUDE.md`, under the **Spec-kit usage rules** section, add a bullet after the **Agent roster** bullet:

```md
- **Live-bound status:** components that show execution status must read it from
  live state, never hardcode it. `<Timeline />` (no `milestones`) renders the
  phase roster and progress bar from execution state — the same source the
  right-rail progress drawer uses, so the two never diverge. `<Phase id="…">`
  overlays live status the same way. Only use the legacy `<Timeline milestones={…}>`
  form for documentation timelines that are not tied to phases.
```

- [ ] **Step 4: Add the spec-authoring rule** — in `skills/spec-authoring/SKILL.md`, add to the rules/guidance list:

```md
- **Timeline is phase-driven.** Use `<Timeline />` (no props) in the overview — it
  renders the live phase roster + progress bar from execution state. Do not
  reintroduce a hand-authored `milestones={[…]}` list for the phase timeline; it
  drifts from the right rail. Each `phases/<NN>-<slug>/spec.mdx` must have a
  frontmatter `title` (the timeline step label); the validator warns when it is
  missing.
```

- [ ] **Step 5: Update the dogfood example** — in `examples/.synergy/sessions/refactor-auth/00-overview.mdx`, replace its `<Timeline milestones={[ ... ]} />` block with `<Timeline />`. (Leave `02-implementation.mdx` Phase cards and `.state/` as-is; the example already has phase folders + a progress.json, so the live timeline will render `storage`/`cutover` with real statuses.)

- [ ] **Step 6: Validate the example session end-to-end**

Run: `node packages/cli/dist/cli.js validate refactor-auth` (from `examples/`), or `pnpm --filter @synergy/cli build` first if `dist` is stale.
Expected: no new errors; at most the intended `title` warnings if any example phase lacks one (fix those by adding titles).

- [ ] **Step 7: Commit**

```bash
git add skills/create-spec/templates/overview-full.mdx skills/create-spec/templates/implementation.mdx CLAUDE.md skills/spec-authoring/SKILL.md examples/.synergy/sessions/refactor-auth/00-overview.mdx
git commit -m "docs: phase-driven Timeline in templates + live-bound convention + example"
```

---

## Final verification

- [ ] **Build the workspace:** `pnpm -r build` — Expected: all packages compile (TS strict, no type errors).
- [ ] **Run all tests:** `pnpm -r test` — Expected: all green.
- [ ] **Manual smoke (optional but recommended):**
  1. `node packages/cli/dist/cli.js preview start` in `examples/`.
  2. Open `http://localhost:4321`, view `refactor-auth`, confirm the overview timeline shows numbered steps with the storage=done / cutover=in-progress statuses and a filled bar.
  3. In another shell: `node packages/cli/dist/cli.js phase set refactor-auth cutover done` (or `curl -X POST .../api/phase`). Confirm the timeline bar advances and the `cutover` step flips to **done within ~1s without a manual refresh** (SSE). Confirm the right rail matches.

## Notes / known limitations

- **CLI `synergy status`** still derives its rollup from `progress.json` touched phases (legacy `deriveProgress`). The folder-based roster lives in the preview server only. This is intentional scope: the visual surfaces (timeline + right rail) are the target. If terminal/preview parity is later wanted, factor `buildRoster` into a shared module both can import.
- **Recursive `fs.watch`** is reliable on macOS/Windows; on Linux it may not fire, in which case the client silently falls back to the 4s poll (correctness preserved, just not instant).
- **Slug rename after a phase is marked done** orphans that done status (slug mismatch) and the step reverts to `proposed` — accepted tradeoff; slugs are the stable identity.
