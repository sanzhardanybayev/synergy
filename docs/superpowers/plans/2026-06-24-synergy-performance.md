# Synergy Performance Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Synergy feel fast by routing per-call operations through the already-running preview daemon (warm, cached, ~5ms) instead of spawning a fresh `node` process (~55–134ms) per call, and by collapsing multi-step skill workflows into single batched calls.

**Architecture:** The preview server on port 4321 is a long-lived process with a Connect-style `/api/*` middleware ([packages/preview/vite-plugin-edit.ts](../../../packages/preview/vite-plugin-edit.ts)). We (1) give the validator an mtime-keyed parse cache so re-validation in a warm process is incremental, (2) expose execution-state mutations + validation as HTTP endpoints that wrap the **same** `@synergy/state` / `@synergy/validator` functions the CLI uses (so the git-committed `.state/` files are byte-identical — no data-model change), (3) add two batch endpoints (`/api/scaffold`, `/api/feedback/resolve-batch`) that turn N agent round-trips into 1, and (4) update the skills to prefer `curl` against the daemon with a CLI fallback when it is down. The CLI keeps working unchanged as the offline path.

**Tech Stack:** TypeScript (strict), pnpm workspaces, Vite 5 dev server + Connect middleware, Node 20+ `fetch`, vitest, biome. No new runtime dependencies.

## Global Constraints

- **pnpm only** — never `npm`/`yarn`. Run commands with the workspace's Node via `eval "$(fnm env)"; fnm use default` first in each shell.
- **TypeScript strict mode on** everywhere. No `any` without a narrowing guard.
- **One package per concern.** Server handlers live in `packages/preview/src/server/`; validation logic stays in `packages/validator`; state mutations stay in `packages/state`. Do not duplicate state logic into preview.
- **The `.state/` files stay git-committed and human-readable.** Daemon handlers MUST call the exact same `@synergy/state` mutations (`setPhaseStatus`, `appendFinding`, `setResume`) as the CLI. No SQLite, no binary store, no alternate on-disk format.
- **Preview port is fixed at 4321** (`PREVIEW_PORT` in [packages/cli/src/paths.ts:23](../../../packages/cli/src/paths.ts)). Do not parameterize it elsewhere.
- **Path-traversal guard required** on every endpoint that takes a `session` name: reject if it contains `/`, `\`, or `..` (mirror `buildProgressResponse` in [packages/preview/src/server/progress.ts:22](../../../packages/preview/src/server/progress.ts)).
- **Server handlers must never crash the dev server** — every handler is wrapped in the middleware's try/catch, but handlers should still return a structured `sendJson(res, <4xx|5xx>, {error})` for expected failures.
- **Every handler gets a pure, HTTP-free core function** (like `buildProgressResponse`) that is unit-tested directly; the `handleX(req, res, …)` wrapper is a thin adapter. Tests live in `packages/preview/tests/server/`.
- **Skills must degrade gracefully:** prefer the daemon (`curl`), but on `ECONNREFUSED` fall back to `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" …`. Never hard-fail because the preview is down.

## Already shipped (context, not work)

PR #7 (`perf/faster-watcher-and-cli`) already: filters `.tmp`/dotfiles + debounces preview reloads, lazy-compiles Ajv schemas, lazy-imports the validator in the CLI, and dedupes a file scan. This plan builds on that branch's `main`.

## Measured baseline (the problem this plan attacks)

| Operation | Now | Target |
|---|---|---|
| Bare `node` spawn (floor) | 55 ms | — (avoided entirely via daemon) |
| `synergy status` / `phase` / `log` / `resume` | ~56 ms (all spawn) | ~5 ms (warm HTTP) |
| `synergy validate` (cold) | 134 ms | ~5 ms warm + incremental (only changed file re-parsed) |
| `create-spec` workflow | 3 `node` spawns + N writes (~5–8 round-trips) | 1 `scaffold` + 1 `validate` call |
| `address-feedback` | 1 `PATCH` per comment + 1 `validate` spawn | 1 `resolve-batch` + 1 `validate` call |

## Non-Goals (and why)

- **SQLite / any binary store.** The state files are 1–2 ms reads and are git-committed for hand-off. A DB optimizes ~1 ms while breaking diffability and adding a native dep. Rejected.
- **Worker-thread parse parallelism.** MDX parsing is synchronous CPU work; a worker pool adds real complexity for sub-100 ms gains at Synergy's scale (3–20 files/session). The mtime cache (Phase 1) removes the repeat cost instead. The concurrency win we *do* take is agent-side: independent `curl` calls run in parallel, and the batch endpoints fan out server-side.
- **True MDX HMR** (module-level replacement instead of full reload). Larger, riskier change; deferred. The Phase-0 watcher fix already removed the redundant double/triple reloads.

---

## File Structure

**New files:**
- `packages/validator/src/cache.ts` — mtime-keyed `parseSpecCached(filePath)`; the warm-process incremental-validation primitive.
- `packages/validator/tests/cache.test.ts` — cache hit/miss-on-mtime-change tests.
- `packages/preview/src/server/execstate.ts` — pure cores + HTTP wrappers for phase/log/resume execution-state mutations.
- `packages/preview/tests/server/execstate.test.ts` — unit tests for the pure cores.
- `packages/preview/src/server/validate.ts` — HTTP wrapper around `@synergy/validator` `validate()`.
- `packages/preview/tests/server/validate.test.ts` — unit test for the validate core.
- `packages/preview/src/server/scaffold.ts` — pure core + HTTP wrapper to create dirs + write files in one call.
- `packages/preview/tests/server/scaffold.test.ts` — scaffold core tests.
- `packages/preview/src/server/feedback-batch.ts` — pure core + HTTP wrapper to resolve/reject many comments at once.
- `packages/preview/tests/server/feedback-batch.test.ts` — batch core tests.
- `packages/cli/src/daemon.ts` — `tryDaemon()` helper: POST/GET the daemon if it's up, else return `null` for the caller to fall back.

**Modified files:**
- `packages/validator/src/validate.ts` — swap `parseSpec` → `parseSpecCached` in `tryParse`.
- `packages/validator/src/index.ts` — export `parseSpecCached`, `clearParseCache`.
- `packages/preview/vite-plugin-edit.ts` — register the new routes.
- `packages/cli/src/cli.ts` — route `phase`/`log`/`resume`/`status`/`validate` through `tryDaemon` first.
- `skills/address-feedback/SKILL.md`, `skills/create-spec/SKILL.md`, `skills/execute/SKILL.md`, `skills/resume/SKILL.md` — prefer daemon endpoints, batch where possible.
- `CLAUDE.md`, `README.md` — document the daemon API + data flow.

---

## Phase 1 — Warm parse cache (incremental validation)

### Task 1: mtime-keyed parse cache in the validator

**Files:**
- Create: `packages/validator/src/cache.ts`
- Test: `packages/validator/tests/cache.test.ts`

**Interfaces:**
- Consumes: `parseSpec(filePath: string): ParsedSpec` from `./parse.js`; `statSync` from `node:fs`.
- Produces:
  - `parseSpecCached(filePath: string): ParsedSpec` — returns a cached `ParsedSpec` when the file's `mtimeMs` is unchanged since last parse; otherwise re-parses and updates the cache. Cache key is the absolute path; the stored entry holds `{ mtimeMs, spec }`.
  - `clearParseCache(): void` — empties the cache (used by tests and available for a future explicit invalidation hook).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/validator/tests/cache.test.ts
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSpecCached, clearParseCache } from '../src/cache.js';

let dir: string;
const MDX = `---\ntitle: T\n---\n\n# Summary\n\ntext\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'synergy-cache-'));
  clearParseCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseSpecCached', () => {
  it('returns the same object instance on a second call when mtime is unchanged', () => {
    const f = join(dir, 'a.mdx');
    writeFileSync(f, MDX, 'utf8');
    const first = parseSpecCached(f);
    const second = parseSpecCached(f);
    expect(second).toBe(first); // identity → cache hit
  });

  it('re-parses when the file mtime changes', () => {
    const f = join(dir, 'a.mdx');
    writeFileSync(f, MDX, 'utf8');
    const first = parseSpecCached(f);
    // bump mtime forward 2s and rewrite
    writeFileSync(f, `${MDX}\n## Goals\n`, 'utf8');
    const future = new Date(Date.now() + 2000);
    utimesSync(f, future, future);
    const second = parseSpecCached(f);
    expect(second).not.toBe(first); // cache miss → fresh parse
  });

  it('clearParseCache forces a re-parse', () => {
    const f = join(dir, 'a.mdx');
    writeFileSync(f, MDX, 'utf8');
    const first = parseSpecCached(f);
    clearParseCache();
    const second = parseSpecCached(f);
    expect(second).not.toBe(first);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/validator test cache`
Expected: FAIL — `Cannot find module '../src/cache.js'`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// packages/validator/src/cache.ts
import { statSync } from 'node:fs';
import { type ParsedSpec, parseSpec } from './parse.js';

interface CacheEntry {
  mtimeMs: number;
  spec: ParsedSpec;
}

const cache = new Map<string, CacheEntry>();

/**
 * Parse an MDX spec, reusing the previous result when the file is unchanged.
 *
 * Keyed by absolute path + `mtimeMs`. In a one-shot CLI process the cache is
 * always cold (no behavioral change); in the long-lived preview daemon repeated
 * validations only re-parse the files that actually changed.
 */
export function parseSpecCached(filePath: string): ParsedSpec {
  const mtimeMs = statSync(filePath).mtimeMs;
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.spec;
  const spec = parseSpec(filePath);
  cache.set(filePath, { mtimeMs, spec });
  return spec;
}

/** Empty the parse cache. */
export function clearParseCache(): void {
  cache.clear();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/validator test cache`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/validator/src/cache.ts packages/validator/tests/cache.test.ts
git commit -m "feat(validator): mtime-keyed parse cache for incremental validation"
```

### Task 2: Wire `validate()` to the cache and export it

**Files:**
- Modify: `packages/validator/src/validate.ts` (the `tryParse` helper)
- Modify: `packages/validator/src/index.ts`

**Interfaces:**
- Consumes: `parseSpecCached`, `clearParseCache` from `./cache.js`.
- Produces: unchanged public `validate(options: ValidateOptions): ValidationReport`; additionally re-exports `parseSpecCached` and `clearParseCache` from the package root.

- [ ] **Step 1: Find the current parse call**

Run: `grep -n "parseSpec\|function tryParse" packages/validator/src/validate.ts`
Expected: a `tryParse` helper that calls `parseSpec(...)`, plus the `import { type ParsedSpec, parseSpec } from './parse.js';` line.

- [ ] **Step 2: Swap the import to the cached parser**

In `packages/validator/src/validate.ts`, change:

```typescript
import { type ParsedSpec, parseSpec } from './parse.js';
```

to:

```typescript
import type { ParsedSpec } from './parse.js';
import { parseSpecCached } from './cache.js';
```

Then in the `tryParse` helper, replace the `parseSpec(` call with `parseSpecCached(`. (There is exactly one call site — the one inside `tryParse`.)

- [ ] **Step 3: Export the cache controls from the package root**

In `packages/validator/src/index.ts`, add after the existing `parseSpec` export line:

```typescript
export { parseSpecCached, clearParseCache } from './cache.js';
```

- [ ] **Step 4: Run the full validator suite to confirm no regression**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/validator test`
Expected: PASS — all existing tests (36) plus the 3 cache tests. The existing `validate.test.ts` proves behavior is unchanged.

- [ ] **Step 5: Typecheck**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/validator typecheck`
Expected: `Done`, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/validator/src/validate.ts packages/validator/src/index.ts
git commit -m "perf(validator): use the warm parse cache inside validate()"
```

---

## Phase 2 — Daemon endpoints for execution state + validation

> `status` is already covered by the existing `GET /api/progress` (returns the derived rollup + journals), so this phase adds **phase**, **log**, **resume**, and **validate** only.

### Task 3: Execution-state mutation cores + HTTP wrappers

**Files:**
- Create: `packages/preview/src/server/execstate.ts`
- Test: `packages/preview/tests/server/execstate.test.ts`

**Interfaces:**
- Consumes: `setPhaseStatus`, `appendFinding`, `setResume`, `type StatusValue` from `@synergy/state`; `readJsonBody`, `sendJson` from `./http.js`.
- Produces (pure cores, each resolves `sessionDir = join(sessionsDir, session)` after a traversal guard):
  - `applyPhaseSet(sessionsDir: string, body: { session: string; phaseId: string; status: StatusValue; note?: string }): void`
  - `applyLog(sessionsDir: string, body: { session: string; text: string; phase?: string; global?: boolean }): void`
  - `applyResume(sessionsDir: string, body: { session: string; next?: string; note?: string }): void`
  - `assertSafeSession(session: string): void` — throws on `/`, `\`, `..`, or empty.
- Produces (HTTP wrappers): `handlePhase`, `handleLog`, `handleResume`, each `(req, res, sessionsDir) => Promise<void>`.

- [ ] **Step 1: Write the failing test (pure cores)**

```typescript
// packages/preview/tests/server/execstate.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProgress } from '@synergy/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyLog, applyPhaseSet, applyResume, assertSafeSession } from '../../src/server/execstate.js';

let sessionsDir: string;
const SESSION = 'refactor-auth';

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'synergy-exec-'));
});
afterEach(() => rmSync(sessionsDir, { recursive: true, force: true }));

describe('execstate cores', () => {
  it('applyPhaseSet writes status + boundary note identically to the CLI path', () => {
    applyPhaseSet(sessionsDir, { session: SESSION, phaseId: 'storage', status: 'done', note: 'dual-write live' });
    const progress = readProgress(join(sessionsDir, SESSION));
    expect(progress.phases.find((p) => p.slug === 'storage')?.status).toBe('done');
    const journal = readFileSync(join(sessionsDir, SESSION, '.state', 'phases', 'storage.md'), 'utf8');
    expect(journal).toContain('dual-write live');
  });

  it('applyPhaseSet rejects an invalid status', () => {
    expect(() =>
      applyPhaseSet(sessionsDir, { session: SESSION, phaseId: 'storage', status: 'nope' as never }),
    ).toThrow(/invalid status/);
  });

  it('applyLog requires a target', () => {
    expect(() => applyLog(sessionsDir, { session: SESSION, text: 'x' })).toThrow(/--phase or --global/);
  });

  it('applyResume sets the hand-off pointer', () => {
    applyResume(sessionsDir, { session: SESSION, next: 'cutover', note: 'start here' });
    const progress = readProgress(join(sessionsDir, SESSION));
    expect(progress.resume.nextPhase).toBe('cutover');
    expect(progress.resume.note).toBe('start here');
  });

  it('assertSafeSession rejects traversal', () => {
    expect(() => assertSafeSession('../escape')).toThrow();
    expect(() => assertSafeSession('ok-name')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/preview test execstate`
Expected: FAIL — `Cannot find module '../../src/server/execstate.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/preview/src/server/execstate.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { type StatusValue, appendFinding, setPhaseStatus, setResume } from '@synergy/state';
import { readJsonBody, sendJson } from './http.js';

const STATUS_VALUES: StatusValue[] = ['draft', 'proposed', 'in-progress', 'blocked', 'done', 'shipped'];

/** Reject session names that could escape the sessions directory. */
export function assertSafeSession(session: string): void {
  if (!session || session.includes('/') || session.includes('\\') || session.includes('..')) {
    throw new Error(`invalid session name: ${session}`);
  }
}

export function applyPhaseSet(
  sessionsDir: string,
  body: { session: string; phaseId: string; status: StatusValue; note?: string },
): void {
  assertSafeSession(body.session);
  if (!STATUS_VALUES.includes(body.status)) {
    throw new Error(`invalid status "${body.status}" — use one of: ${STATUS_VALUES.join(', ')}`);
  }
  setPhaseStatus(join(sessionsDir, body.session), body.phaseId, body.status, { note: body.note });
}

export function applyLog(
  sessionsDir: string,
  body: { session: string; text: string; phase?: string; global?: boolean },
): void {
  assertSafeSession(body.session);
  if (!body.phase && !body.global) {
    throw new Error('a finding needs a target — pass --phase or --global');
  }
  appendFinding(
    join(sessionsDir, body.session),
    body.global ? { global: true } : { phase: body.phase! },
    body.text,
  );
}

export function applyResume(
  sessionsDir: string,
  body: { session: string; next?: string; note?: string },
): void {
  assertSafeSession(body.session);
  setResume(join(sessionsDir, body.session), { nextPhase: body.next, note: body.note });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export async function handlePhase(req: IncomingMessage, res: ServerResponse, sessionsDir: string): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  if (!isRecord(body) || typeof body.session !== 'string' || typeof body.phaseId !== 'string' || typeof body.status !== 'string') {
    sendJson(res, 400, { error: 'bad_request', detail: 'session, phaseId, status are required strings' });
    return;
  }
  try {
    applyPhaseSet(sessionsDir, {
      session: body.session,
      phaseId: body.phaseId,
      status: body.status as StatusValue,
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: 'bad_request', detail: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleLog(req: IncomingMessage, res: ServerResponse, sessionsDir: string): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  if (!isRecord(body) || typeof body.session !== 'string' || typeof body.text !== 'string') {
    sendJson(res, 400, { error: 'bad_request', detail: 'session and text are required strings' });
    return;
  }
  try {
    applyLog(sessionsDir, {
      session: body.session,
      text: body.text,
      phase: typeof body.phase === 'string' ? body.phase : undefined,
      global: body.global === true,
    });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: 'bad_request', detail: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleResume(req: IncomingMessage, res: ServerResponse, sessionsDir: string): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  if (!isRecord(body) || typeof body.session !== 'string') {
    sendJson(res, 400, { error: 'bad_request', detail: 'session is a required string' });
    return;
  }
  try {
    applyResume(sessionsDir, {
      session: body.session,
      next: typeof body.next === 'string' ? body.next : undefined,
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: 'bad_request', detail: err instanceof Error ? err.message : String(err) });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/preview test execstate`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/preview/src/server/execstate.ts packages/preview/tests/server/execstate.test.ts
git commit -m "feat(preview): execution-state mutation handlers (phase/log/resume)"
```

### Task 4: Validation HTTP wrapper

**Files:**
- Create: `packages/preview/src/server/validate.ts`
- Test: `packages/preview/tests/server/validate.test.ts`

**Interfaces:**
- Consumes: `validate` from `@synergy/validator`; `sendJson` from `./http.js`; `projectRoot` (the consumer project root — the middleware already has it).
- Produces:
  - `runValidate(projectRoot: string, session?: string): ValidationReport` — thin pure wrapper that returns the report (warm parse cache makes repeat calls incremental).
  - `handleValidate(req: IncomingMessage, res: ServerResponse, projectRoot: string): void` — `GET /api/validate?session=<name?>`; responds `200` with the full `ValidationReport` JSON.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/preview/tests/server/validate.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runValidate } from '../../src/server/validate.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'synergy-val-'));
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

describe('runValidate', () => {
  it('reports a clean session with zero errors', () => {
    const sessionDir = join(projectRoot, '.synergy', 'sessions', '2026-06-24-x');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, '00-overview.mdx'),
      `---\ntitle: X\ntype: feature\n---\n\n# Summary\n\nhi\n\n# Goals\n\n- g\n`,
      'utf8',
    );
    const report = runValidate(projectRoot, '2026-06-24-x');
    expect(report.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(report.sessionsChecked).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/preview test server/validate`
Expected: FAIL — `Cannot find module '../../src/server/validate.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/preview/src/server/validate.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ValidationReport, validate } from '@synergy/validator';
import { sendJson } from './http.js';

/** Run validation against the consumer project root, optionally scoped to one session. */
export function runValidate(projectRoot: string, session?: string): ValidationReport {
  return validate({ projectRoot, session });
}

/** GET /api/validate?session=<name?> — returns the full ValidationReport JSON. */
export function handleValidate(req: IncomingMessage, res: ServerResponse, projectRoot: string): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const session = url.searchParams.get('session') ?? undefined;
  if (session && (session.includes('/') || session.includes('\\') || session.includes('..'))) {
    sendJson(res, 400, { error: 'bad_request', detail: `invalid session name: ${session}` });
    return;
  }
  try {
    sendJson(res, 200, runValidate(projectRoot, session));
  } catch (err) {
    sendJson(res, 500, { error: 'validate_failed', detail: err instanceof Error ? err.message : String(err) });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/preview test server/validate`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/preview/src/server/validate.ts packages/preview/tests/server/validate.test.ts
git commit -m "feat(preview): GET /api/validate wrapper over @synergy/validator"
```

### Task 5: Register the new routes in the middleware

**Files:**
- Modify: `packages/preview/vite-plugin-edit.ts`

**Interfaces:**
- Consumes: `handlePhase`, `handleLog`, `handleResume` from `./src/server/execstate.js`; `handleValidate` from `./src/server/validate.js`.
- Produces: four new routes — `POST /api/phase`, `POST /api/log`, `POST /api/resume`, `GET /api/validate`.

- [ ] **Step 1: Add the imports**

In `packages/preview/vite-plugin-edit.ts`, add to the import block (after the `handleStatus` import):

```typescript
import { handleLog, handlePhase, handleResume } from './src/server/execstate.js';
import { handleValidate } from './src/server/validate.js';
```

- [ ] **Step 2: Add the routes**

In the `try { … }` block, immediately after the `POST /api/active-session` route and before the `// No route matched` line, insert:

```typescript
          // POST /api/phase — set execution-state phase status (+ optional note)
          if (method === 'POST' && pathname === '/api/phase') {
            await handlePhase(req, res, sessionsDir);
            return;
          }

          // POST /api/log — append a finding to a phase or the global journal
          if (method === 'POST' && pathname === '/api/log') {
            await handleLog(req, res, sessionsDir);
            return;
          }

          // POST /api/resume — write the hand-off pointer
          if (method === 'POST' && pathname === '/api/resume') {
            await handleResume(req, res, sessionsDir);
            return;
          }

          // GET /api/validate?session=<name?> — run cross-ref + schema validation
          if (method === 'GET' && pathname === '/api/validate') {
            handleValidate(req, res, projectRoot);
            return;
          }
```

- [ ] **Step 3: Typecheck the preview package**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/preview typecheck`
Expected: `Done`, no errors.

- [ ] **Step 4: Build, then end-to-end smoke against a live daemon**

Run:
```bash
eval "$(fnm env)"; fnm use default
pnpm build
cd /Users/sanzhar/workspace/synergy
node packages/cli/dist/cli.js preview start --root examples
sleep 2
SES=$(ls examples/.synergy/sessions | head -1)
curl -sS http://localhost:4321/api/validate?session=$SES | head -c 200; echo
curl -sS -X POST http://localhost:4321/api/log -H 'content-type: application/json' -d "{\"session\":\"$SES\",\"text\":\"daemon smoke test\",\"global\":true}"; echo
node packages/cli/dist/cli.js preview stop --root examples
```
Expected: the validate call returns a JSON report with `"filesChecked"`; the log call returns `{"ok":true}`. (Then revert the journal edit if the example session is committed: `git checkout examples`.)

- [ ] **Step 5: Commit**

```bash
git add packages/preview/vite-plugin-edit.ts
git commit -m "feat(preview): register /api/phase, /api/log, /api/resume, /api/validate routes"
```

---

## Phase 3 — Batch endpoints (collapse agent round-trips)

### Task 6: `POST /api/scaffold` — create dirs + write files in one call

**Files:**
- Create: `packages/preview/src/server/scaffold.ts`
- Test: `packages/preview/tests/server/scaffold.test.ts`

**Interfaces:**
- Consumes: `mkdirSync`, `writeFileSync`, `existsSync` from `node:fs`; `join`, `dirname` from `node:path`; `readJsonBody`, `sendJson` from `./http.js`; `assertSafeSession` from `./execstate.js`.
- Produces:
  - `applyScaffold(sessionsDir: string, body: ScaffoldRequest): { written: string[] }` where
    `ScaffoldRequest = { session: string; dirs?: string[]; files: { path: string; content: string }[] }`.
    All `dirs`/`files[].path` are **relative to the session directory**; each is validated to stay inside it (no `..`, no absolute). Parent dirs of each file are created. Returns the list of written relative paths.
  - `handleScaffold(req, res, sessionsDir): Promise<void>` — `POST /api/scaffold`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/preview/tests/server/scaffold.test.ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyScaffold } from '../../src/server/scaffold.js';

let sessionsDir: string;
const SESSION = '2026-06-24-demo';

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'synergy-scaffold-'));
});
afterEach(() => rmSync(sessionsDir, { recursive: true, force: true }));

describe('applyScaffold', () => {
  it('creates dirs and writes files relative to the session, creating parents', () => {
    const out = applyScaffold(sessionsDir, {
      session: SESSION,
      dirs: ['_components', 'assets'],
      files: [
        { path: '00-overview.mdx', content: '# Summary\n' },
        { path: 'phases/01-core/spec.mdx', content: '# Core\n' },
      ],
    });
    expect(out.written).toEqual(['00-overview.mdx', 'phases/01-core/spec.mdx']);
    expect(existsSync(join(sessionsDir, SESSION, '_components'))).toBe(true);
    expect(readFileSync(join(sessionsDir, SESSION, 'phases/01-core/spec.mdx'), 'utf8')).toBe('# Core\n');
  });

  it('rejects a file path that escapes the session dir', () => {
    expect(() =>
      applyScaffold(sessionsDir, { session: SESSION, files: [{ path: '../evil.txt', content: 'x' }] }),
    ).toThrow(/escapes/);
  });

  it('rejects an unsafe session name', () => {
    expect(() => applyScaffold(sessionsDir, { session: '../x', files: [] })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/preview test scaffold`
Expected: FAIL — `Cannot find module '../../src/server/scaffold.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/preview/src/server/scaffold.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { readJsonBody, sendJson } from './http.js';
import { assertSafeSession } from './execstate.js';

export interface ScaffoldRequest {
  session: string;
  dirs?: string[];
  files: { path: string; content: string }[];
}

/** Ensure `rel` resolves inside `base`; throw otherwise. Returns the absolute path. */
function safeJoin(base: string, rel: string): string {
  const abs = resolve(base, rel);
  const r = relative(base, abs);
  if (r.startsWith('..') || resolve(base, r) !== abs || rel.startsWith('/')) {
    throw new Error(`path escapes the session directory: ${rel}`);
  }
  return abs;
}

export function applyScaffold(sessionsDir: string, body: ScaffoldRequest): { written: string[] } {
  assertSafeSession(body.session);
  const sessionDir = join(sessionsDir, body.session);
  mkdirSync(sessionDir, { recursive: true });

  for (const d of body.dirs ?? []) {
    mkdirSync(safeJoin(sessionDir, d), { recursive: true });
  }

  const written: string[] = [];
  for (const f of body.files) {
    const abs = safeJoin(sessionDir, f.path);
    if (!existsSync(dirname(abs))) mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, 'utf8');
    written.push(f.path);
  }
  return { written };
}

function isScaffoldRequest(v: unknown): v is ScaffoldRequest {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.session !== 'string' || !Array.isArray(r.files)) return false;
  return r.files.every(
    (f) => typeof f === 'object' && f !== null && typeof (f as Record<string, unknown>).path === 'string' && typeof (f as Record<string, unknown>).content === 'string',
  );
}

export async function handleScaffold(req: IncomingMessage, res: ServerResponse, sessionsDir: string): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  if (!isScaffoldRequest(body)) {
    sendJson(res, 400, { error: 'bad_request', detail: 'session (string) and files ([{path,content}]) are required' });
    return;
  }
  try {
    sendJson(res, 200, { ok: true, ...applyScaffold(sessionsDir, body) });
  } catch (err) {
    sendJson(res, 400, { error: 'bad_request', detail: err instanceof Error ? err.message : String(err) });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/preview test scaffold`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/preview/src/server/scaffold.ts packages/preview/tests/server/scaffold.test.ts
git commit -m "feat(preview): POST /api/scaffold writes a session's dirs+files in one call"
```

### Task 7: `POST /api/feedback/resolve-batch` — resolve/reject many comments at once

**Files:**
- Create: `packages/preview/src/server/feedback-batch.ts`
- Test: `packages/preview/tests/server/feedback-batch.test.ts`

**Interfaces:**
- Consumes: the existing single-comment patch logic. First inspect `packages/preview/src/server/feedback.ts` for an exported pure mutator. If `handleFeedbackPatch` has an extractable core (e.g. `patchComment(feedbackDir, id, patch)`), reuse it; otherwise add and export `patchComment(feedbackDir: string, id: string, patch: { status: 'resolved' | 'rejected'; resolution?: string; rejection_reason?: string }): void` in `feedback.ts` and have the existing `handleFeedbackPatch` call it.
- Produces:
  - `applyFeedbackBatch(feedbackDir: string, items: BatchItem[]): { results: { id: string; ok: boolean; error?: string }[] }` where `BatchItem = { id: string; status: 'resolved' | 'rejected'; resolution?: string; rejection_reason?: string }`. Applies each independently; one failure does not abort the rest.
  - `handleFeedbackBatch(req, res, feedbackDir): Promise<void>` — `POST /api/feedback/resolve-batch`.

- [ ] **Step 1: Read the existing feedback handler to find/extract the core**

Run: `grep -n "export\|function\|writeFile\|frontmatter\|status" packages/preview/src/server/feedback.ts | head -40`
Expected: locate how `handleFeedbackPatch` rewrites a comment file's frontmatter. If no reusable pure function exists, extract one named `patchComment` (signature above) and make `handleFeedbackPatch` delegate to it. Keep the existing single-patch tests green.

- [ ] **Step 2: Write the failing test**

```typescript
// packages/preview/tests/server/feedback-batch.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyFeedbackBatch } from '../../src/server/feedback-batch.js';

let feedbackDir: string;
const SESSION = 'demo';

function writeComment(id: string) {
  const dir = join(feedbackDir, SESSION);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    `---\nid: ${id}\nstatus: open\nfile: 00-overview.mdx\n---\n\nplease fix\n`,
    'utf8',
  );
}

beforeEach(() => {
  feedbackDir = mkdtempSync(join(tmpdir(), 'synergy-fb-'));
});
afterEach(() => rmSync(feedbackDir, { recursive: true, force: true }));

describe('applyFeedbackBatch', () => {
  it('resolves and rejects multiple comments, reporting per-item results', () => {
    writeComment('a1');
    writeComment('b2');
    const out = applyFeedbackBatch(feedbackDir, [
      { id: 'a1', status: 'resolved', resolution: 'reworded intro' },
      { id: 'b2', status: 'rejected', rejection_reason: 'out of scope' },
    ]);
    expect(out.results).toEqual([
      { id: 'a1', ok: true },
      { id: 'b2', ok: true },
    ]);
    expect(readFileSync(join(feedbackDir, SESSION, 'a1.md'), 'utf8')).toContain('status: resolved');
    expect(readFileSync(join(feedbackDir, SESSION, 'b2.md'), 'utf8')).toContain('status: rejected');
  });

  it('continues past a missing comment and flags it', () => {
    writeComment('a1');
    const out = applyFeedbackBatch(feedbackDir, [
      { id: 'a1', status: 'resolved', resolution: 'x' },
      { id: 'missing', status: 'resolved', resolution: 'y' },
    ]);
    expect(out.results[0]).toEqual({ id: 'a1', ok: true });
    expect(out.results[1].ok).toBe(false);
    expect(out.results[1].error).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/preview test feedback-batch`
Expected: FAIL — `Cannot find module '../../src/server/feedback-batch.js'`.

- [ ] **Step 4: Write the implementation**

```typescript
// packages/preview/src/server/feedback-batch.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { patchComment } from './feedback.js';
import { readJsonBody, sendJson } from './http.js';

export interface BatchItem {
  id: string;
  status: 'resolved' | 'rejected';
  resolution?: string;
  rejection_reason?: string;
}

export function applyFeedbackBatch(
  feedbackDir: string,
  items: BatchItem[],
): { results: { id: string; ok: boolean; error?: string }[] } {
  const results = items.map((item) => {
    try {
      patchComment(feedbackDir, item.id, {
        status: item.status,
        resolution: item.resolution,
        rejection_reason: item.rejection_reason,
      });
      return { id: item.id, ok: true };
    } catch (err) {
      return { id: item.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  return { results };
}

function isBatch(v: unknown): v is { items: BatchItem[] } {
  if (typeof v !== 'object' || v === null) return false;
  const items = (v as Record<string, unknown>).items;
  if (!Array.isArray(items)) return false;
  return items.every((i) => {
    if (typeof i !== 'object' || i === null) return false;
    const r = i as Record<string, unknown>;
    return typeof r.id === 'string' && (r.status === 'resolved' || r.status === 'rejected');
  });
}

export async function handleFeedbackBatch(
  req: IncomingMessage,
  res: ServerResponse,
  feedbackDir: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  if (!isBatch(body)) {
    sendJson(res, 400, { error: 'bad_request', detail: 'items ([{id,status,...}]) is required' });
    return;
  }
  sendJson(res, 200, applyFeedbackBatch(feedbackDir, body.items));
}
```

> If Step 1 found that `patchComment` does not yet exist, add it to `feedback.ts` in this task (extract the frontmatter-rewrite + status/resolution/rejection_reason write from `handleFeedbackPatch`, export it, and make `handleFeedbackPatch` call it). Re-run the existing `feedback.test.ts` to confirm no regression: `pnpm --filter @synergy/preview test server/feedback`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/preview test feedback-batch`
Expected: PASS (2 tests).

- [ ] **Step 6: Register the route**

In `packages/preview/vite-plugin-edit.ts`, add the import:

```typescript
import { handleFeedbackBatch } from './src/server/feedback-batch.js';
```

and a route **before** the `PATCH /api/feedback/:id` regex route (so the literal path wins over the `:id` matcher):

```typescript
          // POST /api/feedback/resolve-batch — resolve/reject many comments at once
          if (method === 'POST' && pathname === '/api/feedback/resolve-batch') {
            await handleFeedbackBatch(req, res, feedbackDir);
            return;
          }
```

- [ ] **Step 7: Typecheck + commit**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/preview typecheck`
Expected: `Done`.

```bash
git add packages/preview/src/server/feedback-batch.ts packages/preview/tests/server/feedback-batch.test.ts packages/preview/src/server/feedback.ts packages/preview/vite-plugin-edit.ts
git commit -m "feat(preview): POST /api/feedback/resolve-batch for one-call comment resolution"
```

---

## Phase 4 — CLI daemon-routing (consistency + offline fallback)

### Task 8: `tryDaemon()` helper

**Files:**
- Create: `packages/cli/src/daemon.ts`

**Interfaces:**
- Consumes: `previewStatus` from `./preview.js`; `PREVIEW_PORT` from `./paths.js`; global `fetch` (Node 20+).
- Produces:
  - `daemonRunning(root?: string): boolean` — true when the PID file points at a live process.
  - `tryDaemon(root: string | undefined, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown | null>` — if the daemon is up, performs the request against `http://localhost:4321<path>` and returns the parsed JSON (throwing on a non-2xx with the server's `detail`); if the daemon is **not** up, returns `null` so the caller falls back to the in-process path. A connection error after a positive liveness check also returns `null`.

- [ ] **Step 1: Write the implementation (no separate unit test — covered by the CLI smoke in Task 9)**

```typescript
// packages/cli/src/daemon.ts
import { PREVIEW_PORT } from './paths.js';
import { previewStatus } from './preview.js';

/** True when a live preview daemon owns the PID file. */
export function daemonRunning(root?: string): boolean {
  return previewStatus(root, PREVIEW_PORT).running;
}

/**
 * Call the daemon if it is up. Returns parsed JSON on success, or `null` when the
 * daemon is down (so the caller runs the operation in-process instead).
 * Throws only when the daemon is up but returns a non-2xx response.
 */
export async function tryDaemon(
  root: string | undefined,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<unknown | null> {
  if (!daemonRunning(root)) return null;
  const url = `http://localhost:${PREVIEW_PORT}${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // PID file said "alive" but the socket refused — fall back in-process.
    return null;
  }
  const text = await resp.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!resp.ok) {
    const detail = (parsed as { detail?: string }).detail ?? `HTTP ${resp.status}`;
    throw new Error(detail);
  }
  return parsed;
}
```

- [ ] **Step 2: Typecheck**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/cli typecheck`
Expected: `Done`.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/daemon.ts
git commit -m "feat(cli): tryDaemon() helper to route ops through the preview server"
```

### Task 9: Route `phase`/`log`/`resume`/`status`/`validate` through the daemon first

**Files:**
- Modify: `packages/cli/src/cli.ts`

**Interfaces:**
- Consumes: `tryDaemon` from `./daemon.js`.
- Produces: each command first attempts the daemon; on `null` (daemon down) it runs the existing in-process function unchanged. Output messages stay the same so the existing `execstate.test.ts` and skills are unaffected.

- [ ] **Step 1: Add the import**

In `packages/cli/src/cli.ts`, add:

```typescript
import { tryDaemon } from './daemon.js';
```

- [ ] **Step 2: Route the `validate` command**

Replace the body of the `validate` action so it tries the daemon first (the daemon returns the same `ValidationReport` shape). Keep the existing rendering for the in-process path:

```typescript
  .action(async (session: string | undefined, flags: { root?: string }) => {
    const projectRoot = resolve(flags.root ?? process.cwd());
    const query = session ? `?session=${encodeURIComponent(session)}` : '';
    let report = (await tryDaemon(flags.root, 'GET', `/api/validate${query}`)) as
      | import('@synergy/validator').ValidationReport
      | null;
    if (!report) {
      const { validate } = await import('@synergy/validator');
      report = validate({ projectRoot, session });
    }
    // …existing rendering of report.issues / summary / exit code, unchanged…
  });
```

- [ ] **Step 3: Route `phase set`**

Inside the `phase` action, after validating `action === 'set'` and that `status` is present, replace the `phaseSet({...})` call with a daemon-first attempt:

```typescript
      try {
        const viaDaemon = await tryDaemon(flags.root, 'POST', '/api/phase', {
          session,
          phaseId,
          status,
          note: flags.note,
        });
        if (!viaDaemon) {
          phaseSet({ root: flags.root, session, phaseId, status: status as never, note: flags.note });
        } else {
          process.stdout.write(`✓ ${session} › phase ${phaseId} → ${status}\n`);
        }
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
```

Make the `phase` action `async`.

- [ ] **Step 4: Route `log` and `resume` the same way**

For `log` (make the action `async`):

```typescript
      try {
        const viaDaemon = await tryDaemon(flags.root, 'POST', '/api/log', {
          session,
          text,
          phase: flags.phase,
          global: flags.global,
        });
        if (!viaDaemon) {
          logFinding({ root: flags.root, session, text, phase: flags.phase, global: flags.global });
        } else {
          process.stdout.write(`✓ logged finding to ${flags.global ? 'global' : `phase ${flags.phase}`}\n`);
        }
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
```

For `resume` (make the action `async`):

```typescript
      try {
        const viaDaemon = await tryDaemon(flags.root, 'POST', '/api/resume', {
          session,
          next: flags.next,
          note: flags.note,
        });
        if (!viaDaemon) {
          resumeSet({ root: flags.root, session, next: flags.next, note: flags.note });
        } else {
          process.stdout.write(`✓ resume → ${flags.next ?? '(unset)'}\n`);
        }
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
```

> `status` already has a daemon equivalent via `GET /api/progress`, but its rendered output lives in `printProgress`. Leave `status` in-process for now (it is already at the ~56 ms floor and the rollup rendering is non-trivial to duplicate); skills that need speed call `GET /api/progress` directly. Note this in the commit message.

- [ ] **Step 5: Build and smoke both paths**

Run:
```bash
eval "$(fnm env)"; fnm use default; pnpm build
cd /Users/sanzhar/workspace/synergy
SES=$(ls examples/.synergy/sessions | head -1)
# Daemon DOWN → in-process fallback:
node packages/cli/dist/cli.js validate $SES --root examples | tail -2
# Daemon UP → routed:
node packages/cli/dist/cli.js preview start --root examples; sleep 2
node packages/cli/dist/cli.js validate $SES --root examples | tail -2
node packages/cli/dist/cli.js preview stop --root examples
```
Expected: both print the same `✓ … 0 error(s)` summary.

- [ ] **Step 6: Run the CLI test suite**

Run: `eval "$(fnm env)"; fnm use default; pnpm --filter @synergy/cli test`
Expected: PASS (existing 11 tests — they exercise the in-process functions directly, which are unchanged).

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/cli.ts
git commit -m "perf(cli): route validate/phase/log/resume through the daemon when it is running"
```

---

## Phase 5 — Skills + docs (the felt win)

### Task 10: `address-feedback` → batch resolution + daemon validate

**Files:**
- Modify: `skills/address-feedback/SKILL.md`

**Interfaces:** uses `POST /api/feedback/resolve-batch` and `GET /api/validate` from Phases 3–4.

- [ ] **Step 1: Replace the per-comment PATCH loop with a single batch call**

In `skills/address-feedback/SKILL.md`, change step 3's resolution mechanism: instead of one `curl … PATCH /api/feedback/<id>` per comment, collect all decisions and issue **one** call after the edits:

```bash
curl -sS -X POST http://localhost:4321/api/feedback/resolve-batch \
  -H 'content-type: application/json' \
  -d '{"items":[
        {"id":"<id1>","status":"resolved","resolution":"<what changed>"},
        {"id":"<id2>","status":"rejected","rejection_reason":"<why>"}
      ]}'
```

Keep the rule that every comment ends as resolved or rejected (never silently skipped), and keep the on-disk frontmatter fallback for when the server is down.

- [ ] **Step 2: Replace the final validate spawn with the daemon endpoint**

Change step 4 from `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" validate <session>` to:

```bash
curl -sS "http://localhost:4321/api/validate?session=<session>"
```

and parse the JSON `issues` array (`severity: "error"` ⇒ must fix). Note the CLI command remains the fallback when the preview is not running.

- [ ] **Step 3: Commit**

```bash
git add skills/address-feedback/SKILL.md
git commit -m "perf(skills): address-feedback uses batch resolve + daemon validate"
```

### Task 11: `create-spec` → scaffold endpoint + daemon validate

**Files:**
- Modify: `skills/create-spec/SKILL.md`

**Interfaces:** uses `POST /api/scaffold` and `GET /api/validate`.

- [ ] **Step 1: Replace the per-file mkdir/write procedure with one scaffold call**

In the "Scaffolding procedure" section, collapse steps 4–5 (create directories, copy templates) so that — after the agent reads the templates and substitutes placeholders in-memory — it writes the whole session in one call:

```bash
curl -sS -X POST http://localhost:4321/api/scaffold \
  -H 'content-type: application/json' \
  -d '{"session":"<YYYY-MM-DD-slug>",
       "dirs":["_components","assets","phases/01-<slug>"],
       "files":[
         {"path":"orchestrator.md","content":"<filled>"},
         {"path":"00-overview.mdx","content":"<filled>"},
         {"path":"phases/01-<slug>/spec.mdx","content":"<filled>"}
       ]}'
```

Keep template **reading** local (`Read` tool on `$CLAUDE_PLUGIN_ROOT/skills/create-spec/templates/`). Note that when the preview is not yet running, the agent falls back to `init` + per-file writes as today.

- [ ] **Step 2: Drop the redundant `init` spawn and switch validate to the endpoint**

Since `/api/scaffold` calls `mkdirSync(sessionDir, { recursive: true })`, the separate `init` step is only needed for a brand-new project (no `.synergy/`). Reword step 2 to: "If `.synergy/` does not exist, run `init` once; otherwise skip it — `scaffold` creates the session directory." Change the final validate (steps 9 and the stop-condition) to `curl -sS "http://localhost:4321/api/validate?session=<session>"`, with the CLI as the documented fallback.

- [ ] **Step 3: Commit**

```bash
git add skills/create-spec/SKILL.md
git commit -m "perf(skills): create-spec scaffolds in one call + daemon validate"
```

### Task 12: `execute` + `resume` → daemon phase/log calls

**Files:**
- Modify: `skills/execute/SKILL.md`, `skills/resume/SKILL.md`

**Interfaces:** uses `POST /api/phase`, `POST /api/log`, `GET /api/progress`.

- [ ] **Step 1: Update the state-write gate in `execute`**

Find the mandatory state-write step that currently runs `phase set` + `log` via the CLI. Replace with daemon-first calls (one each), documenting the CLI fallback:

```bash
curl -sS -X POST http://localhost:4321/api/phase \
  -H 'content-type: application/json' \
  -d '{"session":"<s>","phaseId":"<id>","status":"done","note":"<boundary note>"}'
```

Keep the invariant: the gate is not satisfied until the phase status is written. If the curl fails with connection refused, run the `node … cli.js phase set …` fallback.

- [ ] **Step 2: Update `resume`'s first read**

Where `resume` reads the hand-off pointer, prefer `GET /api/progress?session=<s>` (returns `progress.resume`) when the preview is up; otherwise read `.state/progress.json` / run `status` as today.

- [ ] **Step 3: Commit**

```bash
git add skills/execute/SKILL.md skills/resume/SKILL.md
git commit -m "perf(skills): execute/resume use daemon phase/log/progress endpoints"
```

### Task 13: Document the daemon API + data flow

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: Add an "HTTP API (preview daemon)" subsection**

In `CLAUDE.md`, under the execution-state section, add a table of the daemon endpoints and the rule that skills prefer them with a CLI fallback:

```markdown
## Daemon HTTP API (performance path)

When the preview server is running (port 4321), agents and skills SHOULD use these
endpoints instead of spawning `node cli.js` (~55 ms/call) — they reuse the warm process
and a mtime-keyed parse cache:

| Method + path | Replaces | Body / query |
|---|---|---|
| `POST /api/phase` | `synergy phase set` | `{session, phaseId, status, note?}` |
| `POST /api/log` | `synergy log` | `{session, text, phase?, global?}` |
| `POST /api/resume` | `synergy resume` | `{session, next?, note?}` |
| `GET /api/validate?session=` | `synergy validate` | — (returns ValidationReport JSON) |
| `GET /api/progress?session=` | `synergy status` | — |
| `POST /api/scaffold` | per-file mkdir/write in create-spec | `{session, dirs?, files:[{path,content}]}` |
| `POST /api/feedback/resolve-batch` | per-comment PATCH loop | `{items:[{id,status,resolution?,rejection_reason?}]}` |

All endpoints write the SAME git-committed `.state/` and `feedback/` files as the CLI.
When the preview is down, fall back to the `node cli.js …` command.
```

- [ ] **Step 2: Mirror a short note in `README.md`** (one paragraph + the table) so external users see the fast path.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document the preview-daemon HTTP API and the fast data-flow path"
```

---

## Phase 6 — Full verification + PR

### Task 14: Whole-repo gate and PR

- [ ] **Step 1: Run the complete gate**

Run:
```bash
eval "$(fnm env)"; fnm use default
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```
Expected: build `Done`; typecheck `Done`; all tests pass (existing 236 + new: 3 cache + 5 execstate + 1 validate + 3 scaffold + 2 feedback-batch = 250); biome `No fixes applied` / no errors.

- [ ] **Step 2: End-to-end timing proof**

Run (with the daemon up) and confirm the warm path is an order of magnitude under the CLI floor:
```bash
cd /Users/sanzhar/workspace/synergy
node packages/cli/dist/cli.js preview start --root examples; sleep 2
SES=$(ls examples/.synergy/sessions | head -1)
# warm HTTP validate (expect tens of ms, dominated by curl startup, not node):
for i in 1 2 3; do curl -sS -o /dev/null -w '%{time_total}s\n' "http://localhost:4321/api/validate?session=$SES"; done
node packages/cli/dist/cli.js preview stop --root examples
git checkout examples   # discard any journal writes from smoke tests
```
Expected: each warm validate well under the 0.134 s cold-CLI baseline.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "perf: route Synergy ops through the warm preview daemon + batch endpoints" \
  --body "Adds an mtime-keyed validator parse cache, daemon HTTP endpoints for phase/log/resume/validate, batch endpoints (scaffold, feedback resolve-batch), CLI daemon-routing with in-process fallback, and updates the skills to use the fast path. Same git-committed .state/ files; no new runtime deps. Build/typecheck/test/lint all green."
```

---

## Self-Review

**1. Spec coverage** (against the three levers from the conversation):
- *Lever 1 — daemon routing + warm cache + incremental validate:* Tasks 1–5 (cache + validate/phase/log/resume endpoints), Tasks 8–9 (CLI routing). ✅
- *Lever 2 — collapse round-trips:* Tasks 6–7 (`scaffold`, `feedback/resolve-batch`), Tasks 10–12 (skills use them). ✅
- *Lever 3 — parallelize:* Addressed in Non-Goals with rationale (sync parse → cache, not worker pool) and the agent-side/server-side fan-out the batch endpoints enable. ✅
- *SQLite question:* Explicitly rejected with reasoning in Non-Goals. ✅
- *Docs:* Task 13. ✅

**2. Placeholder scan:** Every code step contains complete, runnable code. The one deliberate "…existing rendering…unchanged…" in Task 9 Step 2 refers to lines already present in `cli.ts:46-57` (the engineer keeps them verbatim) — not a TODO. Task 7 Step 1 is a conditional "extract if absent," with the exact signature given so either branch is fully specified.

**3. Type consistency:**
- `parseSpecCached(filePath: string): ParsedSpec` — defined Task 1, consumed Task 2. ✅
- `assertSafeSession(session: string): void` — defined Task 3, reused in Task 6. ✅
- `ValidationReport` — imported from `@synergy/validator` in Task 4 and Task 9; matches the package's exported type. ✅
- `tryDaemon(root, method, path, body?)` — defined Task 8, called with exactly that arg order in Task 9. ✅
- Endpoint paths are identical between the handler tasks (2–7), the route registrations (Tasks 5, 7), the CLI (Task 9), and the docs (Task 13): `/api/phase`, `/api/log`, `/api/resume`, `/api/validate`, `/api/scaffold`, `/api/feedback/resolve-batch`, `/api/progress`. ✅
- Status value set is the same six in `execstate.ts` (Task 3) as in `@synergy/state` and the existing CLI. ✅
