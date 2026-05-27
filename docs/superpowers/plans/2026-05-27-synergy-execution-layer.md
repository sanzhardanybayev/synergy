# Synergy Execution Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sidecar execution-state layer to Synergy so implementing agents reliably record per-phase status + findings, a fresh-context agent can resume from a hand-off pointer, and the human sees live progress in the preview.

**Architecture:** A new Node-only package `@synergy/state` owns the `.state/` data model (read/write/derive — single source of truth). The CLI writes through it (`synergy phase/log/resume/status`). The validator cross-checks `.state/` against the spec. `@synergy/spec-kit` gains a stable `<Phase id>` plus an `ExecutionStateContext` that `<Phase>` consumes to overlay live status; the preview populates that context from a new `GET /api/progress` endpoint and renders a triggered Progress drawer. New skills (`synergy:execute`, `synergy:resume`) own the disciplined loop.

**Tech Stack:** pnpm workspaces, TypeScript (strict, ESM), tsup (build), Vitest (test), Biome (lint/format), React + Vite + react-router + MDX (preview), `cac` + `kleur` (CLI), `ajv` + remark/unified (validator).

**Conventions baked in (from the codebase):**
- Phase identity is the **slug without numeric prefix** (`cutover`, never `02-cutover`). Execution state keys on this slug.
- `.state/` is **committed** (do NOT add it to `.synergy/.gitignore`).
- Atomic writes: write `.tmp` then `renameSync` over the target.
- Timestamps are ISO 8601 (`new Date().toISOString()`); injectable via a `now` option for deterministic tests.
- Status values reuse `StatusValue` from `@synergy/spec-kit`: `draft | proposed | in-progress | blocked | done | shipped`.
- Run `pnpm format` (Biome) before each commit. Biome's unsafe-fix `noDelete` rule can rewrite `delete obj.x`; avoid `delete` in new code — set keys explicitly instead.
- Commit messages MUST NOT contain `Co-Authored-By` trailers (a commit hook rejects them).

**Per-package commands:**
- Build one: `pnpm --filter @synergy/<pkg> build` · all: `pnpm build`
- Typecheck one: `pnpm --filter @synergy/<pkg> typecheck` · all: `pnpm typecheck`
- Test one: `pnpm --filter @synergy/<pkg> test` · all: `pnpm test`
- Format: `pnpm format` · Lint: `pnpm lint`

---

## Milestone 1 — `@synergy/state` package (data model + IO + derive)

Foundation everything else imports. Pure Node module, fully unit-tested.

### Task 1: Scaffold the `@synergy/state` package

**Files:**
- Create: `packages/state/package.json`
- Create: `packages/state/tsconfig.json`
- Create: `packages/state/tsup.config.ts`
- Create: `packages/state/src/index.ts` (temporary stub)

- [ ] **Step 1: Create `packages/state/package.json`**

```json
{
  "name": "@synergy/state",
  "version": "0.2.4",
  "type": "module",
  "description": "Synergy execution-state layer: read/write/derive .state/ progress + journals.",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@synergy/spec-kit": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "22.10.1",
    "tsup": "8.3.5",
    "typescript": "5.6.3",
    "vitest": "2.1.5"
  }
}
```

- [ ] **Step 2: Create `packages/state/tsconfig.json`** (copy of validator's)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/state/tsup.config.ts`** (single ESM entry; spec-kit is type-only so externalize it)

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@synergy/spec-kit'],
});
```

- [ ] **Step 4: Create a temporary `packages/state/src/index.ts` stub**

```typescript
export const STATE_DIRNAME = '.state';
```

- [ ] **Step 5: Install + verify the workspace picks up the package**

Run: `pnpm install`
Expected: completes without error; `@synergy/state` is linked (it matches `packages/*`).

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/state
git commit -m "feat(state): scaffold @synergy/state package"
```

### Task 2: Types + path helpers

**Files:**
- Create: `packages/state/src/types.ts`
- Create: `packages/state/src/paths.ts`
- Test: `packages/state/src/paths.test.ts`

- [ ] **Step 1: Write the failing test `packages/state/src/paths.test.ts`**

```typescript
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globalJournalPath, phaseJournalPath, progressPath, stateDir } from './paths.js';

const SESSION = '/proj/.synergy/sessions/refactor-auth';

describe('state paths', () => {
  it('stateDir is <session>/.state', () => {
    expect(stateDir(SESSION)).toBe(join(SESSION, '.state'));
  });
  it('progressPath is <session>/.state/progress.json', () => {
    expect(progressPath(SESSION)).toBe(join(SESSION, '.state', 'progress.json'));
  });
  it('phaseJournalPath is <session>/.state/phases/<id>.md', () => {
    expect(phaseJournalPath(SESSION, 'cutover')).toBe(
      join(SESSION, '.state', 'phases', 'cutover.md'),
    );
  });
  it('globalJournalPath is <session>/.state/journal.md', () => {
    expect(globalJournalPath(SESSION)).toBe(join(SESSION, '.state', 'journal.md'));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @synergy/state test`
Expected: FAIL — cannot import from `./paths.js` (module not found).

- [ ] **Step 3: Create `packages/state/src/types.ts`**

```typescript
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
```

- [ ] **Step 4: Create `packages/state/src/paths.ts`**

```typescript
import { join } from 'node:path';

export const STATE_DIRNAME = '.state';

/** Absolute path to a session's `.state/` directory. */
export function stateDir(sessionDir: string): string {
  return join(sessionDir, STATE_DIRNAME);
}

export function progressPath(sessionDir: string): string {
  return join(stateDir(sessionDir), 'progress.json');
}

export function phaseJournalPath(sessionDir: string, phaseId: string): string {
  return join(stateDir(sessionDir), 'phases', `${phaseId}.md`);
}

export function globalJournalPath(sessionDir: string): string {
  return join(stateDir(sessionDir), 'journal.md');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @synergy/state test`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/state/src
git commit -m "feat(state): types + .state path helpers"
```

### Task 3: Progress read/write + derive

**Files:**
- Create: `packages/state/src/progress.ts`
- Test: `packages/state/src/progress.test.ts`

- [ ] **Step 1: Write the failing test `packages/state/src/progress.test.ts`**

```typescript
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveProgress, emptyProgress, readProgress, writeProgress } from './progress.js';
import { progressPath } from './paths.js';

let sessionDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'synergy-state-'));
});
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

describe('readProgress', () => {
  it('returns an empty progress when the file is absent', () => {
    const p = readProgress(sessionDir);
    expect(p.version).toBe(1);
    expect(p.phases).toEqual([]);
    expect(p.resume).toEqual({});
  });
});

describe('writeProgress', () => {
  it('creates .state/progress.json and round-trips', () => {
    const p = emptyProgress();
    p.phases.push({ slug: 'storage', status: 'done' });
    writeProgress(sessionDir, p);
    expect(existsSync(progressPath(sessionDir))).toBe(true);
    const round = readProgress(sessionDir);
    expect(round.phases).toEqual([{ slug: 'storage', status: 'done' }]);
  });

  it('writes indented JSON', () => {
    writeProgress(sessionDir, emptyProgress());
    const raw = readFileSync(progressPath(sessionDir), 'utf8');
    expect(raw).toContain('\n  ');
  });
});

describe('deriveProgress', () => {
  it('counts done + shipped as done and rounds percent', () => {
    const p = emptyProgress();
    p.phases.push(
      { slug: 'a', status: 'done' },
      { slug: 'b', status: 'shipped' },
      { slug: 'c', status: 'in-progress' },
    );
    expect(deriveProgress(p)).toEqual({ done: 2, total: 3, percent: 67 });
  });

  it('is 0/0/0 with no phases', () => {
    expect(deriveProgress(emptyProgress())).toEqual({ done: 0, total: 0, percent: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @synergy/state test`
Expected: FAIL — cannot import `./progress.js`.

- [ ] **Step 3: Create `packages/state/src/progress.ts`**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @synergy/state test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/state/src
git commit -m "feat(state): progress read/write + derived rollup"
```

### Task 4: Mutations — setPhaseStatus, appendFinding, setResume

**Files:**
- Create: `packages/state/src/mutations.ts`
- Test: `packages/state/src/mutations.test.ts`

- [ ] **Step 1: Write the failing test `packages/state/src/mutations.test.ts`**

```typescript
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFinding, setPhaseStatus, setResume } from './mutations.js';
import { globalJournalPath, phaseJournalPath } from './paths.js';
import { readProgress } from './progress.js';

let sessionDir: string;
const now = () => '2026-05-27T10:00:00.000Z';

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'synergy-mut-'));
});
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

describe('setPhaseStatus', () => {
  it('inserts a new phase and stamps startedAt for in-progress', () => {
    setPhaseStatus(sessionDir, 'storage', 'in-progress', { now });
    const p = readProgress(sessionDir);
    expect(p.phases).toEqual([
      { slug: 'storage', status: 'in-progress', startedAt: now(), updatedAt: now() },
    ]);
  });

  it('stamps completedAt for done and keeps the existing startedAt', () => {
    setPhaseStatus(sessionDir, 'storage', 'in-progress', { now: () => '2026-05-27T09:00:00.000Z' });
    setPhaseStatus(sessionDir, 'storage', 'done', { now });
    const phase = readProgress(sessionDir).phases[0]!;
    expect(phase.status).toBe('done');
    expect(phase.startedAt).toBe('2026-05-27T09:00:00.000Z');
    expect(phase.completedAt).toBe(now());
  });

  it('writes a boundary note to the phase journal when --note is given', () => {
    setPhaseStatus(sessionDir, 'storage', 'done', { now, note: 'dual-write live' });
    const journal = readFileSync(phaseJournalPath(sessionDir, 'storage'), 'utf8');
    expect(journal).toContain('done');
    expect(journal).toContain('dual-write live');
    expect(journal).toContain(now());
  });
});

describe('appendFinding', () => {
  it('appends a phase finding as a bullet line', () => {
    appendFinding(sessionDir, { phase: 'storage' }, 'null exp rows backfilled', now);
    const journal = readFileSync(phaseJournalPath(sessionDir, 'storage'), 'utf8');
    expect(journal).toBe(`- ${now()}: null exp rows backfilled\n`);
  });

  it('appends a global finding to journal.md', () => {
    appendFinding(sessionDir, { global: true }, 'auth cache TTL = 300s', now);
    const journal = readFileSync(globalJournalPath(sessionDir), 'utf8');
    expect(journal).toContain('auth cache TTL = 300s');
  });
});

describe('setResume', () => {
  it('stores the resume pointer', () => {
    setResume(sessionDir, { nextPhase: 'cutover', note: 'begin canary 1%' }, now);
    expect(readProgress(sessionDir).resume).toEqual({ nextPhase: 'cutover', note: 'begin canary 1%' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @synergy/state test`
Expected: FAIL — cannot import `./mutations.js`.

- [ ] **Step 3: Create `packages/state/src/mutations.ts`**

```typescript
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
export function setResume(sessionDir: string, resume: ResumePointer, now: NowFn = defaultNow): void {
  const progress = readProgress(sessionDir);
  progress.resume = resume;
  progress.updatedAt = now();
  writeProgress(sessionDir, progress);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @synergy/state test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/state/src
git commit -m "feat(state): setPhaseStatus, appendFinding, setResume mutations"
```

### Task 5: Journal readers + public exports + JSON schema

**Files:**
- Create: `packages/state/src/journals.ts`
- Create: `packages/state/src/schema.ts`
- Modify: `packages/state/src/index.ts` (replace stub)
- Test: `packages/state/src/journals.test.ts`

- [ ] **Step 1: Write the failing test `packages/state/src/journals.test.ts`**

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGlobalJournal, readPhaseJournal } from './journals.js';
import { appendFinding } from './mutations.js';

let sessionDir: string;
beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'synergy-jrnl-'));
});
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

describe('journal readers', () => {
  it('returns null when a phase journal is absent', () => {
    expect(readPhaseJournal(sessionDir, 'storage')).toBeNull();
  });
  it('reads a phase journal that exists', () => {
    appendFinding(sessionDir, { phase: 'storage' }, 'a finding', () => 'T');
    expect(readPhaseJournal(sessionDir, 'storage')).toContain('a finding');
  });
  it('returns null when the global journal is absent', () => {
    expect(readGlobalJournal(sessionDir)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @synergy/state test`
Expected: FAIL — cannot import `./journals.js`.

- [ ] **Step 3: Create `packages/state/src/journals.ts`**

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { globalJournalPath, phaseJournalPath } from './paths.js';

export function readPhaseJournal(sessionDir: string, phaseId: string): string | null {
  const file = phaseJournalPath(sessionDir, phaseId);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function readGlobalJournal(sessionDir: string): string | null {
  const file = globalJournalPath(sessionDir);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
```

- [ ] **Step 4: Create `packages/state/src/schema.ts`** (JSON Schema for the validator's ajv)

```typescript
/** JSON Schema for .state/progress.json — compiled by @synergy/validator's ajv. */
export const progressJsonSchema = {
  type: 'object',
  required: ['version', 'phases'],
  additionalProperties: true,
  properties: {
    version: { const: 1 },
    overallStatus: {
      enum: ['draft', 'proposed', 'in-progress', 'blocked', 'done', 'shipped'],
    },
    resume: {
      type: 'object',
      properties: { nextPhase: { type: 'string' }, note: { type: 'string' } },
    },
    phases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'status'],
        properties: {
          slug: { type: 'string' },
          status: {
            enum: ['draft', 'proposed', 'in-progress', 'blocked', 'done', 'shipped'],
          },
          startedAt: { type: 'string' },
          completedAt: { type: 'string' },
          updatedAt: { type: 'string' },
        },
      },
    },
  },
} as const;
```

- [ ] **Step 5: Replace `packages/state/src/index.ts`**

```typescript
export { STATE_DIRNAME, stateDir, progressPath, phaseJournalPath, globalJournalPath } from './paths.js';
export { emptyProgress, readProgress, writeProgress, deriveProgress } from './progress.js';
export {
  setPhaseStatus,
  appendFinding,
  setResume,
  type SetPhaseOptions,
  type FindingTarget,
} from './mutations.js';
export { readPhaseJournal, readGlobalJournal } from './journals.js';
export { progressJsonSchema } from './schema.js';
export type {
  PhaseState,
  ResumePointer,
  ProgressFile,
  DerivedProgress,
  StatusValue,
} from './types.js';
```

- [ ] **Step 6: Run test + build + typecheck**

Run: `pnpm --filter @synergy/state test && pnpm --filter @synergy/state build && pnpm --filter @synergy/state typecheck`
Expected: tests PASS, build emits `dist/index.js` + `dist/index.d.ts`, typecheck clean.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add packages/state/src
git commit -m "feat(state): journal readers, JSON schema, public exports"
```

---

## Milestone 2 — CLI commands

Wire `@synergy/state` to the `synergy` binary, mirroring the existing `cac` + `kleur` patterns.

### Task 6: Add `@synergy/state` dep + `execstate.ts` command module

**Files:**
- Modify: `packages/cli/package.json` (add dependency)
- Create: `packages/cli/src/execstate.ts`
- Test: `packages/cli/src/execstate.test.ts`

- [ ] **Step 1: Add the dependency to `packages/cli/package.json`**

In the `"dependencies"` object, add (keep alphabetical with the other `@synergy/*` entries):

```json
    "@synergy/state": "workspace:*",
```

Then run: `pnpm install`
Expected: links `@synergy/state` into the CLI package.

- [ ] **Step 2: Write the failing test `packages/cli/src/execstate.test.ts`**

```typescript
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProgress } from '@synergy/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logFinding, phaseSet, printProgress, resumeSet } from './execstate.js';

let root: string;
let sessionDir: string;
const SESSION = 'refactor-auth';

beforeEach(() => {
  root = join(tmpdir(), `synergy-cli-state-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  sessionDir = join(root, '.synergy', 'sessions', SESSION);
  mkdirSync(sessionDir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('phaseSet', () => {
  it('writes phase status into .state/progress.json', () => {
    phaseSet({ root, session: SESSION, phaseId: 'storage', status: 'done', note: 'dual-write live' });
    const p = readProgress(sessionDir);
    expect(p.phases.find((x) => x.slug === 'storage')?.status).toBe('done');
    const journal = readFileSync(join(sessionDir, '.state', 'phases', 'storage.md'), 'utf8');
    expect(journal).toContain('dual-write live');
  });

  it('rejects an invalid status', () => {
    expect(() =>
      phaseSet({ root, session: SESSION, phaseId: 'storage', status: 'nope' as never }),
    ).toThrow(/invalid status/i);
  });

  it('rejects an unknown session directory', () => {
    expect(() =>
      phaseSet({ root, session: 'ghost', phaseId: 'storage', status: 'done' }),
    ).toThrow(/session/i);
  });
});

describe('logFinding', () => {
  it('appends a global finding', () => {
    logFinding({ root, session: SESSION, text: 'cache TTL 300s', global: true });
    const journal = readFileSync(join(sessionDir, '.state', 'journal.md'), 'utf8');
    expect(journal).toContain('cache TTL 300s');
  });
  it('requires either --phase or --global', () => {
    expect(() => logFinding({ root, session: SESSION, text: 'x' })).toThrow(/--phase or --global/i);
  });
});

describe('resumeSet', () => {
  it('stores the resume pointer', () => {
    resumeSet({ root, session: SESSION, next: 'cutover', note: 'canary 1%' });
    expect(readProgress(sessionDir).resume).toEqual({ nextPhase: 'cutover', note: 'canary 1%' });
  });
});

describe('printProgress', () => {
  it('returns a summary string with the derived rollup', () => {
    phaseSet({ root, session: SESSION, phaseId: 'storage', status: 'done' });
    phaseSet({ root, session: SESSION, phaseId: 'cutover', status: 'in-progress' });
    const out = printProgress({ root, session: SESSION });
    expect(out).toContain('1/2');
    expect(out).toContain('cutover');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @synergy/cli test`
Expected: FAIL — cannot import `./execstate.js`.

- [ ] **Step 4: Create `packages/cli/src/execstate.ts`**

```typescript
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendFinding,
  deriveProgress,
  readProgress,
  setPhaseStatus,
  setResume,
  type StatusValue,
} from '@synergy/state';
import { bold, dim, green, red } from 'kleur/colors';
import { resolveProjectPaths } from './paths.js';

const STATUS_VALUES: StatusValue[] = [
  'draft',
  'proposed',
  'in-progress',
  'blocked',
  'done',
  'shipped',
];

function resolveSessionDir(root: string | undefined, session: string): string {
  const paths = resolveProjectPaths(root);
  const dir = join(paths.sessionsDir, session);
  if (!existsSync(dir)) {
    throw new Error(`session "${session}" not found at ${dir}`);
  }
  return dir;
}

export interface PhaseSetArgs {
  root?: string;
  session: string;
  phaseId: string;
  status: StatusValue;
  note?: string;
}

export function phaseSet(args: PhaseSetArgs): void {
  if (!STATUS_VALUES.includes(args.status)) {
    throw new Error(`invalid status "${args.status}" — use one of: ${STATUS_VALUES.join(', ')}`);
  }
  const sessionDir = resolveSessionDir(args.root, args.session);
  setPhaseStatus(sessionDir, args.phaseId, args.status, { note: args.note });
  process.stdout.write(
    `${green('✓')} ${args.session} ${dim('›')} phase ${bold(args.phaseId)} → ${args.status}\n`,
  );
}

export interface LogArgs {
  root?: string;
  session: string;
  text: string;
  phase?: string;
  global?: boolean;
}

export function logFinding(args: LogArgs): void {
  if (!args.phase && !args.global) {
    throw new Error('a finding needs a target — pass --phase <id> or --global');
  }
  const sessionDir = resolveSessionDir(args.root, args.session);
  appendFinding(sessionDir, args.global ? { global: true } : { phase: args.phase! }, args.text);
  const where = args.global ? 'global' : `phase ${args.phase}`;
  process.stdout.write(`${green('✓')} logged finding to ${dim(where)}\n`);
}

export interface ResumeArgs {
  root?: string;
  session: string;
  next?: string;
  note?: string;
}

export function resumeSet(args: ResumeArgs): void {
  const sessionDir = resolveSessionDir(args.root, args.session);
  setResume(sessionDir, { nextPhase: args.next, note: args.note });
  process.stdout.write(`${green('✓')} resume → ${bold(args.next ?? '(unset)')}\n`);
}

export interface ProgressArgs {
  root?: string;
  session: string;
}

/** Returns the rendered summary (also used by tests); the CLI action writes it to stdout. */
export function printProgress(args: ProgressArgs): string {
  const sessionDir = resolveSessionDir(args.root, args.session);
  const progress = readProgress(sessionDir);
  const { done, total, percent } = deriveProgress(progress);
  const lines: string[] = [];
  lines.push(`${bold(args.session)}  ${done}/${total} phases done (${percent}%)`);
  if (progress.resume.nextPhase || progress.resume.note) {
    lines.push(`  next: ${progress.resume.nextPhase ?? '—'}${progress.resume.note ? ` — ${progress.resume.note}` : ''}`);
  }
  for (const phase of progress.phases) {
    lines.push(`  ${dim('•')} ${phase.slug}  ${phase.status}`);
  }
  if (progress.phases.length === 0) lines.push(`  ${dim('(no phases recorded yet)')}`);
  return lines.join('\n');
}
```

> Note: `red` is imported for parity with sibling modules' error styling; if Biome's `noUnusedImports` flags it, drop `red` from the import. Keep `bold, dim, green`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @synergy/cli test`
Expected: PASS (all execstate tests + existing init tests).

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/cli/package.json packages/cli/src/execstate.ts packages/cli/src/execstate.test.ts
git commit -m "feat(cli): execution-state command module (phase/log/resume/status)"
```

### Task 7: Register the commands in `cli.ts` + export from `index.ts`

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Add imports + commands to `packages/cli/src/cli.ts`**

At the top, extend the local import line:

```typescript
import { logFinding, phaseSet, printProgress, resumeSet } from './execstate.js';
```

Immediately before the final `cli.parse();`, insert:

```typescript
cli
  .command('phase <action> <session> <phaseId> [status]', 'Set a phase status (action: set)')
  .option('--root <dir>', 'Project root (default: cwd)')
  .option('--note <text>', 'Boundary note appended to the phase journal')
  .action(
    (
      action: string,
      session: string,
      phaseId: string,
      status: string | undefined,
      flags: { root?: string; note?: string },
    ) => {
      if (action !== 'set') {
        process.stderr.write(red('Error:') + ` unknown phase action "${action}" — use set\n`);
        process.exit(2);
      }
      if (!status) {
        process.stderr.write(red('Error:') + ' phase set requires a <status> argument\n');
        process.exit(2);
      }
      try {
        phaseSet({ root: flags.root, session, phaseId, status: status as never, note: flags.note });
      } catch (err) {
        process.stderr.write(red('Error:') + ` ${(err as Error).message}\n`);
        process.exit(1);
      }
    },
  );

cli
  .command('log <session> <text>', 'Append a finding to a phase journal or the global journal')
  .option('--root <dir>', 'Project root (default: cwd)')
  .option('--phase <id>', 'Phase slug to attach the finding to')
  .option('--global', 'Record a cross-cutting finding in journal.md')
  .action((session: string, text: string, flags: { root?: string; phase?: string; global?: boolean }) => {
    try {
      logFinding({ root: flags.root, session, text, phase: flags.phase, global: flags.global });
    } catch (err) {
      process.stderr.write(red('Error:') + ` ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command('resume <session>', 'Set the resume pointer (where a fresh agent should start)')
  .option('--root <dir>', 'Project root (default: cwd)')
  .option('--next <phaseId>', 'Phase slug to resume from')
  .option('--note <text>', 'Free-text start-here note')
  .action((session: string, flags: { root?: string; next?: string; note?: string }) => {
    try {
      resumeSet({ root: flags.root, session, next: flags.next, note: flags.note });
    } catch (err) {
      process.stderr.write(red('Error:') + ` ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command('status <session>', 'Print the execution-state rollup for a session')
  .option('--root <dir>', 'Project root (default: cwd)')
  .action((session: string, flags: { root?: string }) => {
    try {
      process.stdout.write(`${printProgress({ root: flags.root, session })}\n`);
    } catch (err) {
      process.stderr.write(red('Error:') + ` ${(err as Error).message}\n`);
      process.exit(1);
    }
  });
```

(`red` is already imported in `cli.ts`.)

- [ ] **Step 2: Re-export from `packages/cli/src/index.ts`**

Append:

```typescript
export {
  phaseSet,
  logFinding,
  resumeSet,
  printProgress,
  type PhaseSetArgs,
  type LogArgs,
  type ResumeArgs,
  type ProgressArgs,
} from './execstate.js';
```

- [ ] **Step 3: Build + smoke-test the binary end-to-end**

```bash
pnpm --filter @synergy/state build && pnpm --filter @synergy/cli build
node packages/cli/dist/cli.js phase set refactor-auth storage done --note "smoke test" --root examples
node packages/cli/dist/cli.js status refactor-auth --root examples
```
Expected: first prints `✓ refactor-auth › phase storage → done`; second prints a rollup including `storage  done`. Then clean up the scratch state:

```bash
git checkout -- examples 2>/dev/null; rm -rf examples/.synergy/sessions/refactor-auth/.state
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @synergy/cli typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/cli/src/cli.ts packages/cli/src/index.ts
git commit -m "feat(cli): register phase/log/resume/status commands"
```

---

## Milestone 3 — Validator: phase-id discipline + `.state/` cross-check

### Task 8: Warn when a `<Phase>` lacks a stable `id`

**Files:**
- Modify: `packages/validator/src/validate.ts`
- Test: add cases to `packages/validator/tests/validate.test.ts`

- [ ] **Step 1: Add a failing test to `packages/validator/tests/validate.test.ts`**

Inside a new `describe`:

```typescript
describe('validate — Phase id discipline', () => {
  it('warns when an inline <Phase> has no id', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: minimalOverview('phased'),
      [`${SESSION_REL}/02-implementation.mdx`]: `---
title: 'Impl'
---
import { Phase } from '@synergy/spec-kit';

# Impl

<Phase number={1} title="Storage" />
`,
    });
    const report = validate({ projectRoot: root });
    const warn = report.issues.find(
      (i) => i.severity === 'warning' && i.component === 'Phase' && /\bid\b/.test(i.message),
    );
    expect(warn).toBeDefined();
  });

  it('does not warn when <Phase> has an id', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: minimalOverview('phased'),
      [`${SESSION_REL}/02-implementation.mdx`]: `---
title: 'Impl'
---
import { Phase } from '@synergy/spec-kit';

# Impl

<Phase id="storage" number={1} title="Storage" />
`,
    });
    const report = validate({ projectRoot: root });
    const warn = report.issues.find((i) => i.component === 'Phase' && /\bid\b/.test(i.message));
    expect(warn).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @synergy/validator test`
Expected: FAIL — no such warning emitted yet.

- [ ] **Step 3: Implement the check in `packages/validator/src/validate.ts`**

Inside `validateSession`, in the `for (const comp of spec.components)` loop, after the `unparsedAttributes` block and before the `validators.get(comp.name)` schema check, add:

```typescript
      if (comp.name === 'Phase' && comp.attributes.id === undefined) {
        issues.push({
          file: spec.filePath,
          line: comp.line,
          column: comp.column,
          component: 'Phase',
          severity: 'warning',
          message:
            'Phase has no `id` — add a stable slug (e.g. id="storage") so execution state survives renumbering.',
        });
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @synergy/validator test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/validator/src/validate.ts packages/validator/tests/validate.test.ts
git commit -m "feat(validator): warn on <Phase> without a stable id"
```

### Task 9: Validate `.state/progress.json` shape + cross-check phase slugs

**Files:**
- Modify: `packages/validator/package.json` (add `@synergy/state` dep)
- Create: `packages/validator/src/state.ts`
- Modify: `packages/validator/src/validate.ts` (collect known phase ids; call state check)
- Test: `packages/validator/tests/state.test.ts`

- [ ] **Step 1: Add the dependency to `packages/validator/package.json`**

In `"dependencies"` add:

```json
    "@synergy/state": "workspace:*",
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test `packages/validator/tests/state.test.ts`**

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import { validate } from '../src/validate.js';
import { makeTempProject, minimalOverview } from './helpers.js';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});
function project(files: Record<string, string>): string {
  const { projectRoot, cleanup } = makeTempProject(files);
  cleanups.push(cleanup);
  return projectRoot;
}

const S = '.synergy/sessions/s1';
const overviewWithPhase = `---
title: 't'
---
import { Phase } from '@synergy/spec-kit';

# Title

## Summary

x

## Goals

- a

<Phase id="storage" number={1} title="Storage" />
`;

describe('validate — .state/progress.json', () => {
  it('errors when progress.json is malformed JSON', () => {
    const root = project({
      [`${S}/00-overview.mdx`]: overviewWithPhase,
      [`${S}/.state/progress.json`]: '{ not json',
    });
    const report = validate({ projectRoot: root });
    expect(report.issues.some((i) => i.severity === 'error' && /progress\.json/.test(i.message))).toBe(true);
  });

  it('errors when progress.json references an unknown phase slug', () => {
    const root = project({
      [`${S}/00-overview.mdx`]: overviewWithPhase,
      [`${S}/.state/progress.json`]: JSON.stringify({
        version: 1,
        phases: [{ slug: 'ghost', status: 'done' }],
      }),
    });
    const report = validate({ projectRoot: root });
    expect(report.issues.some((i) => i.severity === 'error' && /ghost/.test(i.message))).toBe(true);
  });

  it('passes when progress.json slugs match known phase ids', () => {
    const root = project({
      [`${S}/00-overview.mdx`]: overviewWithPhase,
      [`${S}/.state/progress.json`]: JSON.stringify({
        version: 1,
        phases: [{ slug: 'storage', status: 'done' }],
      }),
    });
    const report = validate({ projectRoot: root });
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @synergy/validator test`
Expected: FAIL — no `.state` validation yet.

- [ ] **Step 4: Create `packages/validator/src/state.ts`**

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { progressJsonSchema, progressPath, type ProgressFile } from '@synergy/state';
import Ajv from 'ajv';
import type { ValidationIssue } from './types.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const validateProgress = ajv.compile(progressJsonSchema as object);

/**
 * Validate a session's `.state/progress.json` (if present): JSON parse, schema
 * shape, and that each phase slug is a known phase id (folder slug or inline
 * `<Phase id>`). No-op when the file is absent.
 */
export function validateStateForSession(
  sessionDir: string,
  knownPhaseIds: Set<string>,
): ValidationIssue[] {
  const file = progressPath(sessionDir);
  if (!existsSync(file)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return [{ file, severity: 'error', message: `progress.json is not valid JSON: ${(err as Error).message}` }];
  }

  const issues: ValidationIssue[] = [];
  if (!validateProgress(parsed)) {
    for (const e of validateProgress.errors ?? []) {
      issues.push({
        file,
        severity: 'error',
        message: `progress.json ${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
      });
    }
    return issues;
  }

  const progress = parsed as ProgressFile;
  for (const phase of progress.phases) {
    if (!knownPhaseIds.has(phase.slug)) {
      const known = [...knownPhaseIds];
      const hint = known.length ? ` (known: ${known.join(', ')})` : '';
      issues.push({
        file,
        severity: 'error',
        message: `progress.json references unknown phase slug "${phase.slug}"${hint}`,
      });
    }
  }
  return issues;
}
```

- [ ] **Step 5: Wire it into `packages/validator/src/validate.ts`**

Add the import near the other local imports:

```typescript
import { validateStateForSession } from './state.js';
```

`validateSession` already computes `phaseParse` (a `Map<string, ParsedSpec>` of folder phases) and `allParsed` (all specs). After the component-validation loop and before `return issues;`, insert:

```typescript
  // Collect known phase ids: folder slugs + inline <Phase id="..."> values.
  const knownPhaseIds = new Set<string>(phaseParse.parsed.keys());
  for (const spec of allParsed) {
    for (const comp of spec.components) {
      if (comp.name === 'Phase' && typeof comp.attributes.id === 'string') {
        knownPhaseIds.add(comp.attributes.id);
      }
    }
  }
  issues.push(...validateStateForSession(sessionDir, knownPhaseIds));
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter @synergy/validator test`
Expected: PASS (state tests + all existing tests).

- [ ] **Step 7: Build + typecheck**

Run: `pnpm --filter @synergy/state build && pnpm --filter @synergy/validator build && pnpm --filter @synergy/validator typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add packages/validator
git commit -m "feat(validator): validate .state/progress.json shape + phase-slug cross-refs"
```

---

## Milestone 4 — `@synergy/spec-kit`: `<Phase id>`, ExecutionState context, AgentAllocation fan-out

The preview renders the real spec-kit components, so live overlay must flow through a context spec-kit owns.

### Task 10: Add `id` prop to `<Phase>` + the ExecutionState context

**Files:**
- Create: `packages/spec-kit/src/ExecutionState.tsx`
- Modify: `packages/spec-kit/src/components/Phase.tsx`
- Modify: `packages/spec-kit/src/components/index.ts`
- Test: `packages/spec-kit/tests/Phase.test.tsx` (create if absent)

> spec-kit already ships React components consumed in JSX (`Status.tsx` uses hooks), so React + a test renderer are available. Confirm the test setup: check `packages/spec-kit/package.json` for `vitest` + a jsdom/testing-library dev dep and an existing `tests/*.test.tsx`. If spec-kit has **no** test runner configured, add to its `devDependencies` (versions matching the preview package): `vitest`, `@testing-library/react`, `jsdom`, and a `"test": "vitest run"` script + a `vitest.config.ts` with `environment: 'jsdom'`. Mirror `packages/preview`'s vitest config verbatim.

- [ ] **Step 1: Create `packages/spec-kit/src/ExecutionState.tsx`**

```typescript
import { createContext, useContext, type ReactNode } from 'react';
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
```

- [ ] **Step 2: Write the failing test `packages/spec-kit/tests/Phase.test.tsx`**

```typescript
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExecutionStateProvider } from '../src/ExecutionState.js';
import { Phase } from '../src/components/Phase.js';

describe('Phase live overlay', () => {
  it('shows the authored status when no execution state is present', () => {
    render(<Phase id="storage" number={1} title="Storage" status="proposed" />);
    expect(screen.getByText('Proposed')).toBeTruthy();
  });

  it('overlays the live status from execution state by id', () => {
    render(
      <ExecutionStateProvider value={{ phases: { storage: { status: 'done' } } }}>
        <Phase id="storage" number={1} title="Storage" status="proposed" />
      </ExecutionStateProvider>,
    );
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.queryByText('Proposed')).toBeNull();
  });

  it('renders the latest finding peek when present', () => {
    render(
      <ExecutionStateProvider
        value={{ phases: { storage: { status: 'in-progress', latestFinding: 'cache TTL 300s' } } }}
      >
        <Phase id="storage" number={1} title="Storage" status="proposed" />
      </ExecutionStateProvider>,
    );
    expect(screen.getByText(/cache TTL 300s/)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @synergy/spec-kit test`
Expected: FAIL — `Phase` has no `id` prop / no overlay.

- [ ] **Step 4: Update `packages/spec-kit/src/components/Phase.tsx`**

Add the import, `id` prop, and overlay logic. Replace the file body with:

```typescript
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useExecutionState } from '../ExecutionState.js';
import type { StatusValue } from '../types.js';
import { Status } from './Status.js';

export interface PhaseProps {
  number: number;
  title: string;
  /** Stable slug used to key execution state, e.g. "storage". */
  id?: string;
  /** Authored status badge; overridden by live execution state when present. */
  status?: StatusValue;
  summary?: string;
  estimate?: string;
  editable?: boolean;
  statusDirty?: boolean;
  onStatusChange?: (next: StatusValue) => void;
  children?: ReactNode;
}

export function Phase({
  number,
  title,
  id,
  status,
  summary,
  estimate,
  editable = false,
  statusDirty = false,
  onStatusChange,
  children,
}: PhaseProps) {
  const exec = useExecutionState();
  const live = id ? exec.phases[id] : undefined;
  const effectiveStatus = live?.status ?? status;

  return (
    <section className={clsx('sk-phase')} data-phase={number} data-phase-id={id}>
      <header className="sk-phase__header">
        <span className="sk-phase__number">Phase {number}</span>
        <h3 className="sk-phase__title">{title}</h3>
        <div className="sk-phase__meta">
          {effectiveStatus ? (
            <Status
              value={effectiveStatus}
              editable={editable}
              dirty={statusDirty}
              onChange={onStatusChange}
            />
          ) : null}
          {estimate ? <span className="sk-phase__estimate">⏱ {estimate}</span> : null}
        </div>
      </header>
      {summary ? <p className="sk-phase__summary">{summary}</p> : null}
      {live?.latestFinding ? (
        <p className="sk-phase__finding" data-testid="phase-finding">
          {live.latestFinding}
        </p>
      ) : null}
      {children ? <div className="sk-phase__body">{children}</div> : null}
    </section>
  );
}
```

- [ ] **Step 5: Export the context from `packages/spec-kit/src/components/index.ts`**

Append:

```typescript
export {
  ExecutionStateProvider,
  useExecutionState,
} from '../ExecutionState.js';
export type { ExecutionStateView, ExecutionPhaseView } from '../ExecutionState.js';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @synergy/spec-kit test`
Expected: PASS.

- [ ] **Step 7: Add a style for the finding peek in `packages/spec-kit/src/styles.css`**

Find the `.sk-phase__summary` rule and add immediately after it:

```css
.sk-phase__finding {
  margin: 0.25rem 0 0;
  font-size: 0.85em;
  color: var(--sk-muted, #6b7280);
  border-left: 2px solid var(--sk-accent, #6366f1);
  padding-left: 0.5rem;
}
```

- [ ] **Step 8: Build + typecheck + commit**

```bash
pnpm --filter @synergy/spec-kit build && pnpm --filter @synergy/spec-kit typecheck
pnpm format
git add packages/spec-kit
git commit -m "feat(spec-kit): Phase id + ExecutionState context with live overlay"
```

### Task 11: Add fan-out metadata to `<AgentAllocation>`

**Files:**
- Modify: `packages/spec-kit/src/components/AgentAllocation.tsx`
- Modify: `packages/spec-kit/src/types.ts` (add `AgentModel`, `AgentEffort`)
- Modify: `packages/spec-kit/scripts/generate-schemas.ts` consumers — regenerate schema
- Test: `packages/spec-kit/tests/AgentAllocation.test.tsx`

- [ ] **Step 1: Add types to `packages/spec-kit/src/types.ts`**

Append:

```typescript
export type AgentModel = 'opus' | 'sonnet' | 'haiku';
export type AgentEffort = 'low' | 'medium' | 'high' | 'max';
```

- [ ] **Step 2: Write the failing test `packages/spec-kit/tests/AgentAllocation.test.tsx`**

```typescript
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentAllocation } from '../src/components/AgentAllocation.js';

describe('AgentAllocation fan-out metadata', () => {
  it('renders model + effort + count when provided', () => {
    render(
      <AgentAllocation
        entries={[
          {
            name: 'storage-impl',
            type: 'sub-agent',
            responsibility: 'Implement TokenStore',
            phases: ['storage'],
            model: 'opus',
            effort: 'high',
            count: 2,
          },
        ]}
      />,
    );
    expect(screen.getByText(/opus/)).toBeTruthy();
    expect(screen.getByText(/high/)).toBeTruthy();
    expect(screen.getByText(/×2|x2|2/)).toBeTruthy();
  });

  it('accepts slug phases', () => {
    render(
      <AgentAllocation
        entries={[{ name: 'a', type: 'sub-agent', responsibility: 'r', phases: ['cutover'] }]}
      />,
    );
    expect(screen.getByText('cutover')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @synergy/spec-kit test`
Expected: FAIL — entries reject `model`/`effort`/`count`; `phases` rejects strings.

- [ ] **Step 4: Update `packages/spec-kit/src/components/AgentAllocation.tsx`**

Change the interface + add a "Fan-out" column. Replace the file with:

```typescript
import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { AgentEffort, AgentModel, AgentType } from '../types.js';

export interface AgentAllocationEntry {
  name: string;
  type: AgentType;
  responsibility: string;
  /** Phases this agent touches — slugs (preferred) or legacy numbers. */
  phases?: (number | string)[];
  /** Default model for fan-out, e.g. "opus". Overridable per run by the execute skill. */
  model?: AgentModel;
  /** Default thinking effort for fan-out. */
  effort?: AgentEffort;
  /** How many parallel instances to spawn. */
  count?: number;
}

export interface AgentAllocationProps {
  context?: string;
  entries: AgentAllocationEntry[];
  children?: ReactNode;
}

const typeLabel: Record<AgentType, string> = {
  'sub-agent': 'Sub-agent',
  'agent-team': 'Agent team',
  human: 'Human',
};

function fanout(e: AgentAllocationEntry): string {
  if (e.type === 'human') return '—';
  const parts: string[] = [];
  if (e.model) parts.push(e.model);
  if (e.effort) parts.push(e.effort);
  if (e.count && e.count > 1) parts.push(`×${e.count}`);
  return parts.length ? parts.join(' · ') : '—';
}

export function AgentAllocation({ context, entries, children }: AgentAllocationProps) {
  return (
    <div className="sk-allocation">
      {context ? <p className="sk-allocation__context">{context}</p> : null}
      <table className="sk-allocation__table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Type</th>
            <th>Responsibility</th>
            <th>Phases</th>
            <th>Fan-out</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={`${e.name}-${i}`}>
              <td>
                <strong>{e.name}</strong>
              </td>
              <td>
                <span className={clsx('sk-allocation__type', `sk-allocation__type--${e.type}`)}>
                  {typeLabel[e.type]}
                </span>
              </td>
              <td>{e.responsibility}</td>
              <td>{e.phases?.length ? e.phases.join(', ') : '—'}</td>
              <td className="sk-allocation__fanout">{fanout(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {children}
    </div>
  );
}
```

- [ ] **Step 5: Regenerate schemas** (the validator reads `packages/spec-kit/schemas/AgentAllocation.schema.json`)

Run: `pnpm --filter @synergy/spec-kit build`
Then inspect how schemas are produced: open `packages/spec-kit/scripts/generate-schemas.ts` and run the documented generate step (check `packages/spec-kit/package.json` scripts for a `generate`/`schemas` script; run it, e.g. `pnpm --filter @synergy/spec-kit run <script>`). Confirm `schemas/AgentAllocation.schema.json` now permits `model`, `effort`, `count`, and string entries in `phases`.
Expected: the regenerated schema includes the new optional fields. If schema generation is manual, edit `schemas/AgentAllocation.schema.json` directly to add `model` (enum opus/sonnet/haiku), `effort` (enum low/medium/high/max), `count` (number) to the entry properties and allow `string` in the `phases` items `type`.

- [ ] **Step 6: Run test + validator regression**

Run: `pnpm --filter @synergy/spec-kit test && pnpm --filter @synergy/validator test`
Expected: PASS (new AgentAllocation fields validate; existing example still parses).

- [ ] **Step 7: Commit**

```bash
pnpm format
git add packages/spec-kit
git commit -m "feat(spec-kit): AgentAllocation fan-out metadata (model/effort/count) + slug phases"
```

---

## Milestone 5 — Preview server: `GET /api/progress`

### Task 12: Server-side progress handler

**Files:**
- Modify: `packages/preview/package.json` (add `@synergy/state` dep)
- Create: `packages/preview/src/server/progress.ts`
- Modify: `packages/preview/vite-plugin-edit.ts` (register route)
- Test: `packages/preview/tests/server/progress.test.ts`

- [ ] **Step 1: Add the dependency to `packages/preview/package.json`**

In `"dependencies"` add `"@synergy/state": "workspace:*",`. Run `pnpm install`.

- [ ] **Step 2: Write the failing test `packages/preview/tests/server/progress.test.ts`**

Mirror the existing `tests/server/*` style (check a sibling test for the exact import of the handler + how `req`/`res` are faked). The handler signature is `handleProgress(req, res, sessionsDir)`. Test the pure helper instead to avoid HTTP mocking:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setPhaseStatus, appendFinding } from '@synergy/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgressResponse } from '../../src/server/progress.js';

let sessionsDir: string;
const SESSION = 'refactor-auth';

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'synergy-prog-'));
});
afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe('buildProgressResponse', () => {
  it('returns derived rollup + per-phase journals + global journal', () => {
    const sessionDir = join(sessionsDir, SESSION);
    setPhaseStatus(sessionDir, 'storage', 'done', { note: 'dual-write live' });
    setPhaseStatus(sessionDir, 'cutover', 'in-progress');
    appendFinding(sessionDir, { global: true }, 'cache TTL 300s');

    const res = buildProgressResponse(sessionsDir, SESSION);
    expect(res.derived).toEqual({ done: 1, total: 2, percent: 50 });
    expect(res.phaseJournals.storage).toContain('dual-write live');
    expect(res.globalJournal).toContain('cache TTL 300s');
    expect(res.progress.phases.map((p) => p.slug)).toEqual(['storage', 'cutover']);
  });

  it('rejects a session with a path separator', () => {
    expect(() => buildProgressResponse(sessionsDir, '../escape')).toThrow();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @synergy/preview test`
Expected: FAIL — cannot import `buildProgressResponse`.

- [ ] **Step 4: Create `packages/preview/src/server/progress.ts`**

```typescript
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
export function handleProgress(req: IncomingMessage, res: ServerResponse, sessionsDir: string): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const session = url.searchParams.get('session');
  if (!session) {
    sendJson(res, 400, { error: 'missing session' });
    return;
  }
  try {
    sendJson(res, 200, buildProgressResponse(sessionsDir, session));
  } catch (err) {
    sendJson(res, 400, { error: 'bad_request', detail: err instanceof Error ? err.message : String(err) });
  }
}
```

- [ ] **Step 5: Register the route in `packages/preview/vite-plugin-edit.ts`**

Add the import at the top:

```typescript
import { handleProgress } from './src/server/progress.js';
```

(Match the relative path the other handlers use — they import from `./src/server/...`.) Inside the middleware `try` block, alongside the other `GET` routes, add:

```typescript
          if (method === 'GET' && pathname === '/api/progress') {
            handleProgress(req, res, sessionsDir);
            return;
          }
```

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm --filter @synergy/state build && pnpm --filter @synergy/preview test && pnpm --filter @synergy/preview typecheck`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add packages/preview/package.json packages/preview/src/server/progress.ts packages/preview/vite-plugin-edit.ts packages/preview/tests/server/progress.test.ts
git commit -m "feat(preview): GET /api/progress endpoint"
```

---

## Milestone 6 — Preview client: live badges + Progress drawer

### Task 13: Client progress provider + API call

**Files:**
- Modify: `packages/preview/src/api.ts` (add `getProgress`)
- Create: `packages/preview/src/ProgressProvider.tsx`

- [ ] **Step 1: Add `getProgress` to `packages/preview/src/api.ts`**

Append:

```typescript
// ---------------------------------------------------------------------------
// GET /api/progress
// ---------------------------------------------------------------------------

export interface PhaseStateDto {
  slug: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}
export interface ProgressDto {
  progress: {
    version: 1;
    overallStatus: string;
    resume: { nextPhase?: string; note?: string };
    phases: PhaseStateDto[];
  };
  derived: { done: number; total: number; percent: number };
  phaseJournals: Record<string, string>;
  globalJournal: string | null;
}

export async function getProgress(session: string): Promise<ProgressDto> {
  const res = await fetch(`/api/progress?session=${encodeURIComponent(session)}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /api/progress failed (${res.status}): ${text}`);
  }
  return (await res.json()) as ProgressDto;
}
```

- [ ] **Step 2: Create `packages/preview/src/ProgressProvider.tsx`**

Fetches progress, polls, and provides BOTH spec-kit's `ExecutionStateContext` (for inline badges) and a preview-local context (for the drawer). Polling mirrors `ActiveSessionPinger`.

```typescript
import { ExecutionStateProvider, type ExecutionStateView } from '@synergy/spec-kit';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getProgress, type ProgressDto } from './api.js';

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
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @synergy/preview typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
pnpm format
git add packages/preview/src/api.ts packages/preview/src/ProgressProvider.tsx
git commit -m "feat(preview): client ProgressProvider + getProgress API"
```

### Task 14: ProgressDrawer component

**Files:**
- Create: `packages/preview/src/ProgressDrawer.tsx`
- Modify: `packages/preview/src/app.css` (drawer-reuse styles, add progress-specific rules)
- Test: `packages/preview/tests/ProgressDrawer.test.tsx`

- [ ] **Step 1: Write the failing test `packages/preview/tests/ProgressDrawer.test.tsx`**

```typescript
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProgressDto } from '../src/api.js';
import { ProgressDrawer } from '../src/ProgressDrawer.js';

const data: ProgressDto = {
  progress: {
    version: 1,
    overallStatus: 'in-progress',
    resume: { nextPhase: 'cutover', note: 'begin canary 1%' },
    phases: [
      { slug: 'storage', status: 'done' },
      { slug: 'cutover', status: 'in-progress' },
    ],
  },
  derived: { done: 1, total: 2, percent: 50 },
  phaseJournals: { storage: '\n## done — T\ndual-write live\n' },
  globalJournal: '- T: cache TTL 300s\n',
};

describe('ProgressDrawer', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<ProgressDrawer open={false} data={data} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows derived progress, phases, resume pointer, and global journal when open', () => {
    render(<ProgressDrawer open data={data} onClose={() => {}} />);
    expect(screen.getByText(/1\s*\/\s*2/)).toBeTruthy();
    expect(screen.getByText('storage')).toBeTruthy();
    expect(screen.getByText('cutover')).toBeTruthy();
    expect(screen.getByText(/begin canary 1%/)).toBeTruthy();
    expect(screen.getByText(/cache TTL 300s/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @synergy/preview test`
Expected: FAIL — cannot import `ProgressDrawer`.

- [ ] **Step 3: Create `packages/preview/src/ProgressDrawer.tsx`** (reuses the `.drawer` styles from OrchestratorDrawer)

```typescript
import { useEffect } from 'react';
import type { ProgressDto } from './api.js';

interface Props {
  open: boolean;
  data: ProgressDto | null;
  onClose: () => void;
}

export function ProgressDrawer({ open, data, onClose }: Props) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const derived = data?.derived ?? { done: 0, total: 0, percent: 0 };
  const phases = data?.progress.phases ?? [];
  const resume = data?.progress.resume ?? {};

  return (
    // biome-ignore lint/a11y/useSemanticElements: role=dialog matches OrchestratorDrawer pattern
    <div className="drawer" role="dialog" aria-modal="true" aria-label="Execution progress">
      <button type="button" className="drawer__backdrop" aria-label="Close progress" onClick={onClose} />
      <aside className="drawer__panel">
        <header className="drawer__header">
          <h2 className="drawer__title">Progress</h2>
          <button type="button" className="drawer__close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="drawer__body">
          <div className="progress-rollup">
            <div className="progress-rollup__bar" aria-hidden="true">
              <div className="progress-rollup__fill" style={{ width: `${derived.percent}%` }} />
            </div>
            <p className="progress-rollup__label">
              {derived.done} / {derived.total} phases done ({derived.percent}%)
            </p>
          </div>

          {(resume.nextPhase || resume.note) && (
            <div className="progress-resume">
              <strong>Next:</strong> {resume.nextPhase ?? '—'}
              {resume.note ? ` — ${resume.note}` : ''}
            </div>
          )}

          <ul className="progress-phases">
            {phases.map((p) => (
              <li key={p.slug} className="progress-phases__item">
                <span className={`sk-status sk-status--${p.status}`} data-status={p.status}>
                  <span className="sk-status__dot" aria-hidden />
                  {p.status}
                </span>
                <span className="progress-phases__slug">{p.slug}</span>
                {data?.phaseJournals[p.slug] ? (
                  <details className="progress-phases__journal">
                    <summary>journal</summary>
                    <pre>{data.phaseJournals[p.slug]}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>

          {data?.globalJournal ? (
            <div className="progress-global">
              <h3>Cross-cutting log</h3>
              <pre>{data.globalJournal}</pre>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @synergy/preview test`
Expected: PASS.

- [ ] **Step 5: Add styles to `packages/preview/src/app.css`** (append at end of file)

```css
.progress-rollup__bar {
  height: 8px;
  background: #e5e7eb;
  border-radius: 4px;
  overflow: hidden;
}
.progress-rollup__fill {
  height: 100%;
  background: #6366f1;
  transition: width 0.3s ease;
}
.progress-rollup__label {
  margin: 0.4rem 0 0.8rem;
  font-weight: 600;
}
.progress-resume {
  background: #f3f4f6;
  border-left: 3px solid #6366f1;
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  margin-bottom: 1rem;
  font-size: 0.9em;
}
.progress-phases {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.progress-phases__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.progress-phases__slug {
  font-family: var(--mono, monospace);
}
.progress-phases__journal pre,
.progress-global pre {
  white-space: pre-wrap;
  background: #f9fafb;
  padding: 0.5rem;
  border-radius: 4px;
  font-size: 0.8em;
}
```

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/preview/src/ProgressDrawer.tsx packages/preview/src/app.css packages/preview/tests/ProgressDrawer.test.tsx
git commit -m "feat(preview): ProgressDrawer component + styles"
```

### Task 15: Wire provider + drawer + toggle into SessionShell

**Files:**
- Modify: `packages/preview/src/SessionShell.tsx`

- [ ] **Step 1: Add imports to `packages/preview/src/SessionShell.tsx`**

```typescript
import { ProgressProvider, useProgressData } from './ProgressProvider.js';
import { ProgressDrawer } from './ProgressDrawer.js';
```

- [ ] **Step 2: Wrap the session content in `ProgressProvider` and add the drawer + toggle**

The `ProgressProvider` must wrap the whole `.layout` so the inline `<Phase>` badges (in the Outlet), the drawer, and the toggle all share one fetch. `useProgressData()` can only be read *inside* the provider, so the drawer is rendered via a small host child.

(a) In `SessionInner`, add drawer state next to the existing `commentsPanelOpen` state:

```typescript
  const [progressOpen, setProgressOpen] = useState(false);
```

(b) Add this host component at the bottom of the file (it reads progress data from context):

```typescript
function ProgressDrawerHost({ open, onClose }: { open: boolean; onClose: () => void }) {
  const data = useProgressData();
  return <ProgressDrawer open={open} data={data} onClose={onClose} />;
}
```

(c) In `SessionInner`'s returned JSX, replace the existing `<div className="layout"> … </div>` block (the one containing `Sidebar`, `<main>`, and `OrchestratorDrawer`) with a `ProgressProvider`-wrapped version that also renders the drawer host + a fixed toggle button. Leave `<UnloadGuard />`, `<ActiveSessionPinger />`, and the comments-panel host exactly where they are (outside the provider is fine):

```typescript
      <ProgressProvider session={session.name}>
        <div className="layout">
          <Sidebar
            sessions={sessions}
            currentSessionName={session.name}
            onOpenOrchestrator={openOrchestrator}
          />
          <main className="layout__main">
            <Outlet />
          </main>
          <OrchestratorDrawer
            open={drawer !== null}
            title={drawer?.title ?? ''}
            path={drawer?.path ?? ''}
            loader={drawer?.loader ?? (async () => ({ default: '' }))}
            onClose={closeDrawer}
          />
          <ProgressDrawerHost open={progressOpen} onClose={() => setProgressOpen(false)} />
        </div>

        <button
          type="button"
          className="progress-toggle"
          onClick={() => setProgressOpen((v) => !v)}
          aria-expanded={progressOpen}
          aria-label={progressOpen ? 'Close progress' : 'Open progress'}
        >
          {progressOpen ? '✕' : '📊'}
        </button>
      </ProgressProvider>
```

- [ ] **Step 3: Add toggle style to `packages/preview/src/app.css`** (append)

```css
.progress-toggle {
  position: fixed;
  right: 1rem;
  bottom: 4.5rem;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
  border: 1px solid #d1d5db;
  background: #fff;
  cursor: pointer;
  font-size: 1.1rem;
  z-index: 40;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
}
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @synergy/preview typecheck && pnpm --filter @synergy/preview build`
Expected: clean.

- [ ] **Step 5: Manual verification in the browser**

```bash
pnpm build
# seed some state on the example so there's something to see
node packages/cli/dist/cli.js phase set refactor-auth storage done --note "dual-write live" --root examples
node packages/cli/dist/cli.js phase set refactor-auth cutover in-progress --root examples
node packages/cli/dist/cli.js resume refactor-auth --next cutover --note "begin canary 1%" --root examples
node packages/cli/dist/cli.js preview start --root examples
```
Open `http://localhost:4321/`. Verify: (a) the 📊 toggle opens a drawer showing "1 / 2 phases done (50%)", the phases list, the resume pointer, and the journal; (b) on the implementation page, the `<Phase>` whose `id` matches shows the live status badge (once Task 17 gives the example phases ids). Then:

```bash
node packages/cli/dist/cli.js preview stop --root examples
git checkout -- examples 2>/dev/null; rm -rf examples/.synergy/sessions/refactor-auth/.state
```

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/preview/src/SessionShell.tsx packages/preview/src/app.css
git commit -m "feat(preview): wire ProgressProvider + Progress drawer + toggle into SessionShell"
```

---

## Milestone 7 — Skills, commands, fan-out, docs, dogfood

### Task 16: `synergy:execute` and `synergy:resume` skills + commands

**Files:**
- Create: `skills/execute/SKILL.md`
- Create: `skills/resume/SKILL.md`
- Create: `commands/synergy-execute.md`
- Create: `commands/synergy-resume.md`

- [ ] **Step 1: Create `skills/execute/SKILL.md`**

```markdown
---
name: execute
description: Use when the user runs /synergy-execute or asks Claude to implement a Synergy spec session phase by phase. Owns the disciplined execution loop — reads orchestrator + live .state, works one phase at a time, and writes a boundary note + flips phase status via the synergy CLI before moving on. Honors run-time directives (scope, model/effort overrides) layered above the plan.
---

# execute

Drives implementation of a Synergy session with a hard state-write gate. State is written ONLY through the `synergy` CLI (never by hand-editing `.state/`).

CLI base: `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js"`.

## Steps

**1. Resolve the session + directives**
- The user's request is `$ARGUMENTS`. The first token (if it looks like a session slug) is the session; the rest are run-time directives (e.g. "only Phase 1", "use sonnet").
- If no session is given, read `.synergy/active-session` (JSON `{ session, lastSeen }`); use it if `lastSeen` is within 10 minutes, else ask which session.

**2. Read state first, then strategy, then detail**
- Run `synergy status <session>` — note the rollup and the resume pointer.
- Read `.synergy/sessions/<session>/orchestrator.md` (strategy, dependency graph, agent allocation).
- Read the relevant phase `spec.mdx` (folder phases under `phases/<NN>-<slug>/`, or the `<Phase id>` blocks in the implementation spec).

**3. Pick the next phase and mark it in-progress**
- Choose the lowest-ordered phase whose status is not `done`/`shipped` (respect any scope directive).
- `synergy phase set <session> <phaseId> in-progress`

**4. Implement the phase**
- Fan out per the `<AgentAllocation>` entries for this phase: spawn the specified agent `type`, `count`, `model`, and `effort`. Run-time directives override these for THIS run only — never rewrite `<AgentAllocation>`.
- As you discover anything surprising or reusable, record it: `synergy log <session> "<finding>" --phase <phaseId>` (or `--global` for cross-cutting findings).
- Run the phase's verification gate (from orchestrator.md).

**5. [MANDATORY GATE] Close out the phase before moving on**
You may NOT start the next phase until all three are done:
- `synergy phase set <session> <phaseId> done --note "<terse boundary note: what changed, deviations>"`
- `synergy resume <session> --next <nextPhaseId> --note "<where the next agent should start>"`
- Stop for the human checkpoint defined at this phase boundary.

**6. Repeat** from step 3 until all phases are done (or the scope directive's stopping point is reached). Then print the final `synergy status <session>`.

## Don'ts
- Don't hand-edit `.state/` JSON or journals — always go through the CLI.
- Don't skip the boundary note or resume pointer — that's the hand-off a fresh agent depends on.
- Don't let a run directive ("use sonnet") mutate the stored `<AgentAllocation>` plan.
- Don't mark a phase `done` if its verification gate failed — use `blocked` and log why.
```

- [ ] **Step 2: Create `skills/resume/SKILL.md`**

```markdown
---
name: resume
description: Use when the user runs /synergy-resume or asks a fresh-context agent to continue an in-progress Synergy session. Reconstructs context from the execution-state hand-off (resume pointer + journals) before reading the plan, then continues the execute loop from where the previous agent stopped.
---

# resume

The fresh-context entry point. Reads state FIRST so you start exactly where the last agent left off.

CLI base: `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js"`.

## Steps

**1. Resolve the session + directives** — same as `synergy:execute` step 1 (`$ARGUMENTS`; fall back to `.synergy/active-session`).

**2. Load the hand-off (state first)**
- `synergy status <session>` — read the rollup and the **resume pointer** (`next` + note). This is your starting instruction.
- Read `.synergy/sessions/<session>/.state/phases/<nextPhase>.md` and any prior phases' boundary notes.
- Read `.synergy/sessions/<session>/.state/journal.md` (cross-cutting findings).

**3. Load strategy + detail**
- Read `orchestrator.md`, then the `spec.mdx` for the phase named by the resume pointer.

**4. Continue**
- Hand off to the `synergy:execute` loop starting at its step 3, beginning with the resume pointer's `nextPhase`. Apply any run-time directives the user passed.

## Don'ts
- Don't start by reading the plan — read the resume pointer + journals first; they encode what actually happened.
- Don't re-do completed phases (status `done`/`shipped`) unless a directive says to re-verify.
```

- [ ] **Step 3: Create `commands/synergy-execute.md`**

```markdown
---
description: Implement a Synergy spec session phase by phase, updating execution state at each boundary
argument-hint: [session] [directives...]
---

Invoke the `synergy:execute` skill to implement a Synergy session with the disciplined state-write loop.

The user's request: `$ARGUMENTS`
```

- [ ] **Step 4: Create `commands/synergy-resume.md`**

```markdown
---
description: Resume an in-progress Synergy session from its execution-state hand-off
argument-hint: [session] [directives...]
---

Invoke the `synergy:resume` skill to continue a Synergy session from where the last agent stopped.

The user's request: `$ARGUMENTS`
```

- [ ] **Step 5: Commit**

```bash
git add skills/execute skills/resume commands/synergy-execute.md commands/synergy-resume.md
git commit -m "feat(plugin): synergy:execute + synergy:resume skills and slash commands"
```

### Task 17: Dogfood the example + document the layer

**Files:**
- Modify: `examples/.synergy/sessions/refactor-auth/02-implementation.mdx` (add `id` to phases; slug + fan-out on AgentAllocation)
- Create: `examples/.synergy/sessions/refactor-auth/.state/progress.json`
- Create: `examples/.synergy/sessions/refactor-auth/.state/phases/storage.md`
- Create: `examples/.synergy/sessions/refactor-auth/.state/journal.md`
- Modify: `CLAUDE.md` (document the execution layer + new commands/skills)
- Modify: `AGENTS.md` if present, else note in CLAUDE.md

- [ ] **Step 1: Give the example phases stable ids**

In `examples/.synergy/sessions/refactor-auth/02-implementation.mdx`, add `id` to each `<Phase>` (slug only, no numeric prefix):
- `<Phase number={1} ...>` → add `id="storage"`
- `<Phase number={2} ...>` → add `id="cutover"`
- `<Phase number={3} ...>` → add `id="cleanup"`

And update the `<AgentAllocation>` `entries` to use slug phases + fan-out metadata, e.g.:

```jsx
    { name: 'storage-impl', type: 'sub-agent', responsibility: 'Implement TokenStore + ComplianceStore', phases: ['storage'], model: 'opus', effort: 'high', count: 1 },
    { name: 'service-wiring', type: 'sub-agent', responsibility: 'Wire dual-write, instrumentation', phases: ['storage'], model: 'opus', effort: 'high' },
    { name: 'migration-team', type: 'agent-team', responsibility: 'Read cutover + backfill, with canary supervision', phases: ['cutover'], model: 'opus', effort: 'max' },
    { name: 'audit-prep', type: 'sub-agent', responsibility: 'Compliance audit packet', phases: ['cleanup'], model: 'sonnet', effort: 'medium' },
    { name: 'avery', type: 'human', responsibility: 'Approve each phase boundary', phases: ['storage', 'cutover', 'cleanup'] },
    { name: 'riya', type: 'human', responsibility: 'Compliance sign-off after Phase 3', phases: ['cleanup'] },
```

- [ ] **Step 2: Generate the example `.state/` via the CLI** (don't hand-write — prove the tools)

```bash
pnpm build
node packages/cli/dist/cli.js phase set refactor-auth storage done --note "Dual-write live; legacy rows with null exp were backfilled before enabling writes." --root examples
node packages/cli/dist/cli.js phase set refactor-auth cutover in-progress --root examples
node packages/cli/dist/cli.js log refactor-auth "Auth cache TTL is undocumented = 300s; affects canary read validation." --global --root examples
node packages/cli/dist/cli.js resume refactor-auth --next cutover --note "Phase 1 done; baseline p95 captured. Begin canary at 1% and watch latency." --root examples
node packages/cli/dist/cli.js status refactor-auth --root examples
```
Expected: `status` prints `1/3 phases done (33%)` with the resume pointer.

- [ ] **Step 3: Validate the dogfood session**

Run: `node packages/cli/dist/cli.js validate refactor-auth --root examples`
Expected: no errors. (Phase-id warnings should be gone now that ids exist; `.state/` slugs resolve.)

- [ ] **Step 4: Update `CLAUDE.md`**

Add a section documenting: the `.state/` layer (committed), the phase-id requirement, the four new CLI commands (`phase set`, `log`, `resume`, `status`), the `synergy:execute` / `synergy:resume` skills + `/synergy-execute` `/synergy-resume` commands, the AgentAllocation fan-out fields, and the directive contract (directives affect the run, not the stored plan). Place it after the "Inline editing and feedback (v2)" section as "## Execution state and hand-off (v3)". Add to "## Commands": `synergy phase set | log | resume | status`.

- [ ] **Step 5: Full verification sweep**

Run: `pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm lint`
Expected: build clean, typecheck clean, all tests pass, Biome reports no NEW errors (the repo carries a known dirty lint baseline — compare against `main`; do not introduce new violations).

- [ ] **Step 6: Commit**

```bash
pnpm format
git add examples CLAUDE.md
git commit -m "docs+example: dogfood execution state in refactor-auth; document the layer"
```

### Task 18: Version bump

**Files:**
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Modify: each `packages/*/package.json` version (optional, keep in lockstep with the existing release convention)

- [ ] **Step 1: Bump version to 0.3.0**

Set `version` to `0.3.0` in `.claude-plugin/plugin.json` and the plugin entry in `.claude-plugin/marketplace.json`. (Follow the established release process — the prior release bumped manifest versions only; mirror that.)

- [ ] **Step 2: Final full sweep**

Run: `pnpm build && pnpm test && pnpm typecheck`
Expected: all clean.

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin
git commit -m "chore(release): 0.3.0 — execution state + agent hand-off layer"
```

---

## Verification gates (whole-feature)

A reviewer should be able to confirm:

1. **State core:** `pnpm --filter @synergy/state test` green; `readProgress` returns empty on missing file; `deriveProgress` rounds correctly; `setPhaseStatus` stamps timestamps + writes journal note.
2. **CLI:** `synergy phase set / log / resume / status` work against `examples`; invalid status and unknown session error with exit 1.
3. **Validator:** warns on `<Phase>` without `id`; errors on malformed `progress.json` and unknown phase slugs; existing tests still pass.
4. **spec-kit:** `<Phase id>` overlays live status from context and shows the finding peek; `<AgentAllocation>` renders fan-out metadata; standalone (no provider) still renders authored status.
5. **Preview:** `GET /api/progress` returns derived rollup + journals; the 📊 drawer shows progress/phases/resume/journal; inline phase badges reflect `.state/` in the browser.
6. **Skills:** `/synergy-execute` and `/synergy-resume` exist and describe the state-write gate and state-first read order.
7. **Whole repo:** `pnpm build && pnpm typecheck && pnpm test` all green; no new Biome violations vs. `main`.
