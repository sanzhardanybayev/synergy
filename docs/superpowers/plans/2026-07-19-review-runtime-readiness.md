# Review Runtime Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Synergy `0.12.1` with prebuilt plugin runtime artifacts and a truthful, project-identified preview lifecycle that returns a reachable review URL without requiring a workspace build.

**Architecture:** A shared artifact manifest makes the Git-backed plugin archive self-checking. The CLI owns an atomic per-project runtime record and launches a compiled preview child over IPC. The child binds a loopback port, exposes identity-aware health and authenticated shutdown endpoints, and reports readiness only after the parent independently verifies it.

**Tech Stack:** TypeScript 5.6, Node.js 20, pnpm 10.28.2, Vite 5, CAC, Vitest, GitHub Actions.

## Global Constraints

- Preserve the approved design in `docs/superpowers/specs/2026-07-19-review-performance-hardening-design.md`.
- Treat port `4321` as preferred, not globally reserved; an explicit `--port` remains strict.
- Bind only to `127.0.0.1`; never trust a persisted arbitrary origin.
- Never signal a PID unless a health response proves matching project and instance identity.
- Runtime metadata is atomic, mode `0600`, and contains a random control token that health never returns.
- A start command prints success only after the parent health check passes.
- Keep source packages authoritative; committed `dist` is deterministic release output checked for drift.
- Subagents do not commit. The root integrator runs the listed commit steps after review.
- Preserve the known baseline watcher timeout in `packages/preview/tests/server/feedback-stream.test.ts`; do not weaken or skip it.

---

### Task 1: Define and enforce the tracked runtime artifact contract

**Files:**
- Create: `packages/plugin-guard/src/artifacts.ts`
- Create: `packages/plugin-guard/src/check-artifacts.ts`
- Create: `packages/plugin-guard/tests/artifacts.test.ts`
- Modify: `.gitignore`
- Modify: `packages/plugin-guard/package.json`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

```ts
export const RUNTIME_OUTPUT_ROOTS = [
  'packages/cli/dist',
  'packages/review-core/dist',
  'packages/spec-kit/dist',
  'packages/state/dist',
  'packages/validator/dist',
] as const;

export const REQUIRED_RUNTIME_ARTIFACTS = [
  'packages/cli/dist/cli.js',
  'packages/cli/dist/index.js',
  'packages/review-core/dist/index.js',
  'packages/review-core/dist/source-capture-worker.js',
  'packages/spec-kit/dist/index.js',
  'packages/state/dist/index.js',
  'packages/validator/dist/index.js',
] as const;

export interface ArtifactInspection {
  missing: string[];
  untracked: string[];
  drifted: string[];
  forbidden: string[];
}

export function inspectRuntimeArtifacts(root: string): ArtifactInspection;
export function assertRuntimeArtifacts(root: string): void;
```

- [ ] **Step 1: Write failing artifact tests**

Cover a complete fixture, a missing required entry, an untracked generated chunk, source-capture worker removal, drift after a simulated build, and a tracked `node_modules` path. Use an injected Git runner or a temporary Git fixture so tests do not inspect the developer worktree.

```ts
it('requires the non-static source capture worker', () => {
  const fixture = makeArtifactFixture();
  fixture.remove('packages/review-core/dist/source-capture-worker.js');
  expect(inspectRuntimeArtifacts(fixture.root).missing).toContain(
    'packages/review-core/dist/source-capture-worker.js',
  );
});
```

- [ ] **Step 2: Prove the tests fail for the missing module**

Run: `pnpm --filter @synergy/plugin-guard test -- artifacts.test.ts`

Expected: FAIL because `src/artifacts.ts` does not exist.

- [ ] **Step 3: Implement the canonical manifest and checker**

Use `git ls-files`, `git status --porcelain=v1 --untracked-files=all -- <roots...>`, and filesystem existence checks. Sort every reported path. The command must exit nonzero with one actionable line per issue.

- [ ] **Step 4: Make only declared dist roots trackable**

Keep global `dist/`, then add anchored exceptions for the five roots and their contents. Do not unignore `packages/preview/dist` or any `node_modules` path.

- [ ] **Step 5: Add release scripts and CI gates**

Add:

```json
{
  "check:artifacts": "tsx packages/plugin-guard/src/check-artifacts.ts",
  "build:runtime": "pnpm --filter @synergy/cli --filter @synergy/review-core --filter @synergy/spec-kit --filter @synergy/state --filter @synergy/validator build",
  "check:artifact-drift": "pnpm build:runtime && pnpm check:artifacts"
}
```

CI must run the prebuild check, rebuild, and rerun the checker before tests. A dirty or untracked runtime output is failure.

- [ ] **Step 6: Verify the focused contract**

Run: `pnpm --filter @synergy/plugin-guard test -- artifacts.test.ts`

Run: `pnpm --filter @synergy/plugin-guard typecheck`

Expected: PASS.

- [ ] **Step 7: Root integrator commit**

`git add .gitignore package.json .github/workflows/ci.yml packages/plugin-guard && git commit -m "build(plugin): enforce runtime artifacts"`

---

### Task 2: Add an atomic project runtime record

**Files:**
- Create: `packages/cli/src/preview-runtime.ts`
- Create: `packages/cli/src/preview-runtime.test.ts`
- Modify: `packages/cli/src/paths.ts`
- Modify: `packages/cli/src/init.ts`
- Modify: `packages/cli/src/init.test.ts`

**Interfaces:**

```ts
export interface PreviewRuntimeState {
  schemaVersion: 1;
  protocolVersion: 1;
  state: 'ready';
  instanceId: string;
  projectId: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
  origin: string;
  preferredPort: number;
  strictPort: boolean;
  startedAt: string;
  controlToken: string;
  toolVersion: string;
}

export interface PreviewHealth {
  protocolVersion: 1;
  state: 'ready';
  instanceId: string;
  projectId: string;
  pid: number;
  port: number;
}

export function deriveProjectId(canonicalRoot: string): string;
export function deriveLoopbackOrigin(port: number): string;
export function readPreviewRuntime(path: string): PreviewRuntimeState | null;
export function writePreviewRuntime(path: string, state: PreviewRuntimeState): void;
export function removeOwnedPreviewRuntime(path: string, instanceId: string): boolean;
```

- [ ] **Step 1: Write failing validation and ownership tests**

Test canonical-root hashing, port bounds, fixed loopback host, origin derivation, malformed JSON, schema rejection, atomic replace, final mode `0600`, and instance-owned cleanup.

- [ ] **Step 2: Run the focused test and observe failure**

Run: `pnpm --filter @synergy/cli test -- preview-runtime.test.ts`

Expected: FAIL because `preview-runtime.ts` does not exist.

- [ ] **Step 3: Implement strict parsing and atomic writes**

Write to a same-directory temporary file with mode `0600`, `renameSync`, then `chmodSync(path, 0o600)`. Validate every persisted field and reconstruct `origin` from `port`; reject mismatches rather than honoring them.

- [ ] **Step 4: Extend project paths and initialization**

Add `previewRuntimeFile` and `previewLockFile`. Gitignore `preview.runtime.json`, `preview.start.lock`, and the legacy `preview.pid`; preserve log behavior.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @synergy/cli test -- preview-runtime.test.ts init.test.ts`

Run: `pnpm --filter @synergy/cli typecheck`

Expected: PASS.

- [ ] **Step 6: Root integrator commit**

`git add packages/cli/src && git commit -m "feat(preview): persist identified runtime state"`

---

### Task 3: Give the preview child health and authenticated shutdown

**Files:**
- Create: `packages/preview/src/server/runtime-api.ts`
- Create: `packages/preview/tests/server/runtime-api.test.ts`
- Create: `packages/cli/src/preview-child.ts`
- Modify: `packages/preview/vite-plugin-edit.ts`
- Modify: `packages/preview/vite.config.ts`
- Modify: `packages/cli/tsup.config.ts`
- Modify: `packages/cli/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

```ts
export interface RuntimeApiOptions {
  health: PreviewHealth;
  controlToken: string;
  shutdown(instanceId: string): Promise<void>;
}

export function runtimeApiMiddleware(options: RuntimeApiOptions): Connect.NextHandleFunction;
```

The compiled child accepts launch configuration through environment variables, calls Vite programmatically, and sends exactly one IPC message:

```ts
type PreviewChildMessage =
  | { type: 'ready'; instanceId: string; pid: number; port: number; listenMs: number }
  | { type: 'failed'; instanceId: string; phase: string; message: string };
```

- [ ] **Step 1: Write failing HTTP contract tests**

Assert health omits path/token, shutdown rejects missing or wrong token with `401`, rejects a wrong instance with `409`, accepts both matching values, and all routes reject non-loopback requests when address information is present.

- [ ] **Step 2: Run and observe failure**

Run: `pnpm --filter @synergy/preview test -- runtime-api.test.ts`

Expected: FAIL because the runtime API does not exist.

- [ ] **Step 3: Implement the runtime middleware**

Use constant-time token comparison after equal-length validation. Return JSON with explicit status codes. Schedule shutdown after the response has ended so the response is delivered.

- [ ] **Step 4: Implement the compiled child launcher**

Add `preview-child` to tsup entries. Add `vite` as a direct CLI runtime dependency because the launcher imports `createServer`. Configure `host: '127.0.0.1'`, requested port, and `strictPort` from launch input. Read the actual address only after `server.listen()` resolves. On SIGTERM, close Vite cleanly.

- [ ] **Step 5: Verify package boundaries**

Run: `pnpm --filter @synergy/preview test -- runtime-api.test.ts`

Run: `pnpm --filter @synergy/cli typecheck`

Run: `pnpm --filter @synergy/cli build`

Expected: PASS and `packages/cli/dist/preview-child.js` exists.

- [ ] **Step 6: Root integrator commit**

`git add packages/preview packages/cli pnpm-lock.yaml && git commit -m "feat(preview): expose identified runtime control"`

---

### Task 4: Replace optimistic preview startup with readiness verification

**Files:**
- Rewrite: `packages/cli/src/preview.ts`
- Create: `packages/cli/src/preview.test.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/daemon.ts`
- Modify: `packages/cli/src/index.ts`

**Public result:**

```ts
export interface PreviewStatus {
  running: boolean;
  pid: number | null;
  port: number | null;
  origin: string | null;
  projectId: string;
  instanceId: string | null;
  timings?: {
    lockMs: number;
    launchMs: number;
    listenMs: number;
    healthMs: number;
    totalMs: number;
  };
}

export async function previewStatus(root?: string): Promise<PreviewStatus>;
export async function previewStart(options?: PreviewStartOptions): Promise<PreviewStatus>;
export async function previewStop(root?: string): Promise<boolean>;
```

- [ ] **Step 1: Write failing lifecycle tests with injected process/HTTP adapters**

Cover:

- default `4321` occupied selects a different reachable port;
- explicit occupied port rejects and never emits the success marker;
- a child ready message with the wrong instance or project fails;
- two same-project starts converge on one runtime;
- distinct project roots may run simultaneously;
- status rejects malformed, dead, or identity-mismatched state;
- stop uses authenticated HTTP and never calls `process.kill` for an unverified PID;
- stale legacy PID is removed, while a live unverified legacy PID is untouched;
- timeout/child exit cleans only state owned by the attempt and includes bounded log tail.

- [ ] **Step 2: Run and observe contract failures**

Run: `pnpm --filter @synergy/cli test -- preview.test.ts`

Expected: FAIL against the current synchronous PID implementation.

- [ ] **Step 3: Implement serialized launch and health polling**

Acquire the same-project lock with exclusive creation and bounded stale-lock recovery. Generate `attemptId`, `instanceId`, and 32 random control-token bytes. Spawn the compiled child with IPC, wait at most ten seconds, independently fetch health, compare protocol/project/instance/PID/port, then publish runtime state and print success.

- [ ] **Step 4: Implement verified status and stop**

Status reads metadata, derives the origin, and performs a short health request. Stop posts `{ instanceId }` with the bearer token, waits up to three seconds for health to disappear, and removes only matching metadata.

- [ ] **Step 5: Make CLI and daemon async**

Await all preview actions in CAC handlers. `preview status --json` emits the full typed object. The daemon reads a healthy runtime origin; it does not construct `localhost:4321`.

- [ ] **Step 6: Verify lifecycle behavior**

Run: `pnpm --filter @synergy/cli test -- preview.test.ts`

Run: `pnpm --filter @synergy/cli test`

Run: `pnpm --filter @synergy/cli typecheck`

Expected: PASS.

- [ ] **Step 7: Root integrator commit**

`git add packages/cli/src && git commit -m "fix(preview): verify readiness before success"`

---

### Task 5: Make review URLs runtime-authoritative

**Files:**
- Modify: `packages/cli/src/review-actions.ts`
- Modify: `packages/cli/src/review-cli.ts`
- Modify: `packages/cli/src/review-actions.test.ts`
- Modify: `packages/cli/src/review-cli.test.ts`
- Modify: `skills/review/SKILL.md`
- Modify: `commands/synergy-review.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

**Error contract:**

```ts
export class PreviewNotReadyError extends Error {
  readonly code = 'preview_not_ready';
  constructor(readonly root: string) {
    super(`Preview is not ready. Run: synergy preview start --root ${JSON.stringify(root)}`);
  }
}
```

- [ ] **Step 1: Write failing open tests**

Assert a healthy origin produces `http://127.0.0.1:<port>/r/<workspace>/<revision>`, no runtime returns typed nonzero JSON, and `review open` never starts preview implicitly.

- [ ] **Step 2: Run and observe failure**

Run: `pnpm --filter @synergy/cli test -- review-actions.test.ts review-cli.test.ts`

Expected: FAIL because `openReview()` returns a relative route.

- [ ] **Step 3: Implement async runtime-backed open**

Validate the review bundle first, obtain verified preview status, append the encoded review route with `new URL`, and return the full URL. Teach `analysis-set` and `open` to accept `--json` without changing other option rules.

- [ ] **Step 4: Remove fixed-origin guidance**

Replace every user-facing `localhost:4321` promise with `preview start --json`, `review open`, or the runtime-returned origin. Preserve `4321` only where described as the preferred default.

- [ ] **Step 5: Verify**

Run: `rg -n "https?://localhost:4321|https?://127\\.0\\.0\\.1:4321" README.md AGENTS.md CLAUDE.md commands skills packages/cli/src`

Expected: no user-facing constructed review URL.

Run: `pnpm --filter @synergy/cli test`

Expected: PASS.

- [ ] **Step 6: Root integrator commit**

`git add packages/cli skills commands README.md AGENTS.md CLAUDE.md && git commit -m "feat(review): open verified preview URLs"`

---

### Task 6: Ship the buildless plugin archive and smoke it

**Files:**
- Create: `packages/plugin-guard/src/smoke-plugin-archive.ts`
- Create: `packages/plugin-guard/tests/plugin-archive.test.ts`
- Modify: `commands/synergy-setup.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `skills/*/SKILL.md`
- Modify: `.github/workflows/ci.yml`
- Add generated: `packages/{cli,review-core,spec-kit,state,validator}/dist/**`

- [ ] **Step 1: Write an archive smoke test that initially fails**

Create `git archive HEAD` in a temporary directory, preserve checksums, install frozen dependencies, and run only:

```bash
node packages/cli/dist/cli.js --help
node packages/cli/dist/cli.js validate --root examples
node packages/cli/dist/cli.js review create --staged --root <fixture> --json
node packages/cli/dist/cli.js preview start --root <fixture> --json
node packages/cli/dist/cli.js preview stop --root <fixture> --json
```

No build command may occur. Recheck artifact checksums after execution.

- [ ] **Step 2: Change setup to install-only**

The setup command runs `pnpm install --frozen-lockfile` followed by CLI help. Remove build, tsup, and Vite build instructions.

- [ ] **Step 3: Bump and synchronize version `0.12.1`**

Update `.claude-plugin/plugin.json`, then run:

`pnpm exec tsx packages/plugin-guard/src/version-sync.ts`

- [ ] **Step 4: Build and stage deterministic runtime output**

Run: `pnpm build:runtime`

Run: `git add -f packages/cli/dist packages/review-core/dist packages/spec-kit/dist packages/state/dist packages/validator/dist`

Run: `pnpm check:artifacts`

Run: `pnpm build:runtime && git status --short -- packages/cli/dist packages/review-core/dist packages/spec-kit/dist packages/state/dist packages/validator/dist`

Expected: no output from the final status command.

- [ ] **Step 5: Run full verification**

Run: `pnpm typecheck`

Run: `pnpm lint`

Run: `pnpm test`

Run: `pnpm build`

Run: `pnpm exec tsx packages/plugin-guard/src/version-sync.ts --check`

Run: `pnpm exec tsx packages/plugin-guard/src/smoke-plugin-archive.ts`

Expected: all pass. If the known feedback-stream watcher test flakes, rerun that exact test once and record both outputs; do not suppress it.

- [ ] **Step 6: Root integrator final logic review**

Confirm no success output precedes health, no bare PID kill remains, all origins derive from validated ports, explicit ports are strict, and cleanup is attempt-owned.

- [ ] **Step 7: Root integrator commit**

`git add . && git commit -m "chore(plugin): ship buildless runtime 0.12.1"`

- [ ] **Step 8: Push and open PR after verification**

`git push -u origin codex/review-runtime-readiness`

Create a PR titled `fix(review): make plugin and preview runtime ready` with the metric, archive-smoke evidence, port-conflict evidence, and the known baseline watcher note.
