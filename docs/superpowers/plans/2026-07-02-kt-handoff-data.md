# KT-Handoff Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the live agent capture a knowledge-transfer snapshot on demand into a git-committed `.state/handoff.md`, and guarantee the next agent reads it first regardless of entry point.

**Architecture:** A thin latest-wins `handoff.md` baton file per session sits on top of the append-only journals. A new `synergy handoff` CLI verb + `POST /api/handoff` daemon route write it (same tryDaemon→fallback pattern as phase/log/resume). A new `/synergy-handoff` skill has the live agent self-author the snapshot; `execute` and `continue` skills are patched to read `handoff.md` before anything else.

**Tech Stack:** TypeScript (strict), pnpm workspaces, vitest 2.1.5, Node fs, Connect-style middleware in `vite-plugin-edit.ts`, Claude Code plugin skills/commands (markdown).

## Global Constraints

- pnpm only (never npm/yarn); `pnpm -r run test` runs all package tests.
- TypeScript strict mode; ESM imports use `.js` extensions on relative paths.
- `.state/` is git-committed; writes are atomic (tmp + rename), mirroring `writeProgress`.
- State is mutated ONLY through `@synergy/state` primitives — never hand-edit JSON.
- Daemon endpoints and CLI must write byte-identical `.state/` files.
- Any behavior change under `skills/`, `packages/`, `commands/` MUST bump `.claude-plugin/plugin.json` `version` (release-gate CI). Never hand-edit `marketplace.json` or `synergy-version` markers — lefthook `version-sync` derives them.
- Preview port is fixed at 4321.
- Session names must pass `assertSafeSession` (no `/`, `\`, `..`, `\0`).

---

### Task 1: State primitives — `handoff.ts`

**Files:**
- Create: `packages/state/src/handoff.ts`
- Create: `packages/state/src/handoff.test.ts`
- Modify: `packages/state/src/paths.ts` (add `handoffPath`)
- Modify: `packages/state/src/index.ts` (export new symbols)

**Interfaces:**
- Consumes: `stateDir(sessionDir)` from `./paths.js`.
- Produces:
  - `handoffPath(sessionDir: string): string` → `<sessionDir>/.state/handoff.md`
  - `writeHandoff(sessionDir: string, body: string, now?: () => string): void` — atomic overwrite; prepends `# Handoff — <ISO ts>\n\n` heading.
  - `readHandoff(sessionDir: string): string | null` — file contents or `null`.

- [ ] **Step 1: Write the failing test**

Create `packages/state/src/handoff.test.ts`:

```typescript
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handoffPath, readHandoff, writeHandoff } from './handoff.js';

let sessionDir: string;
beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'synergy-ho-'));
});
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

const fixedNow = () => '2026-07-02T12:00:00.000Z';

describe('handoff', () => {
  it('returns null when no handoff exists', () => {
    expect(readHandoff(sessionDir)).toBeNull();
  });

  it('writes a handoff with a timestamped heading and reads it back', () => {
    writeHandoff(sessionDir, '## What I did\nStuff.\n', fixedNow);
    const body = readHandoff(sessionDir);
    expect(body).not.toBeNull();
    expect(body).toContain('# Handoff — 2026-07-02T12:00:00.000Z');
    expect(body).toContain('## What I did');
  });

  it('overwrites (latest-wins) on a second write', () => {
    writeHandoff(sessionDir, 'first', () => '2026-07-02T12:00:00.000Z');
    writeHandoff(sessionDir, 'second', () => '2026-07-02T13:00:00.000Z');
    const body = readHandoff(sessionDir) ?? '';
    expect(body).toContain('second');
    expect(body).not.toContain('first');
    expect(body).toContain('13:00:00');
  });

  it('handoffPath points inside .state', () => {
    expect(handoffPath(sessionDir)).toBe(join(sessionDir, '.state', 'handoff.md'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/state exec vitest run src/handoff.test.ts`
Expected: FAIL — `Cannot find module './handoff.js'`.

- [ ] **Step 3: Add `handoffPath` to `paths.ts`**

Append to `packages/state/src/paths.ts`:

```typescript
export function handoffPath(sessionDir: string): string {
  return join(stateDir(sessionDir), 'handoff.md');
}
```

- [ ] **Step 4: Create `handoff.ts`**

Create `packages/state/src/handoff.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { handoffPath } from './paths.js';

type NowFn = () => string;
const defaultNow: NowFn = () => new Date().toISOString();

/** Write the latest-wins handoff baton. Atomic: tmp + rename. Overwrites any prior file. */
export function writeHandoff(sessionDir: string, body: string, now: NowFn = defaultNow): void {
  const file = handoffPath(sessionDir);
  mkdirSync(dirname(file), { recursive: true });
  const stamp = now();
  const contents = `# Handoff — ${stamp}\n\n${body.trimEnd()}\n`;
  const tmp = join(dirname(file), `.handoff.${stamp.replace(/[:.]/g, '-')}.tmp`);
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, file);
}

/** Read the current handoff baton, or null when none exists. */
export function readHandoff(sessionDir: string): string | null {
  const file = handoffPath(sessionDir);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
```

- [ ] **Step 5: Export from `index.ts`**

In `packages/state/src/index.ts`, add `handoffPath` to the `./paths.js` export block and add a new line:

```typescript
export { writeHandoff, readHandoff } from './handoff.js';
```

The `./paths.js` block becomes:

```typescript
export {
  STATE_DIRNAME,
  stateDir,
  progressPath,
  phaseJournalPath,
  globalJournalPath,
  handoffPath,
} from './paths.js';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @synergy/state exec vitest run src/handoff.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/state/src/handoff.ts packages/state/src/handoff.test.ts packages/state/src/paths.ts packages/state/src/index.ts
git commit -m "feat(state): add handoff.md read/write primitives"
```

---

### Task 2: CLI — `synergy handoff` verb

**Files:**
- Modify: `packages/cli/src/execstate.ts` (add `handoffSet`)
- Modify: `packages/cli/src/cli.ts` (register `handoff` command)
- Create: `packages/cli/src/handoff.test.ts`

**Interfaces:**
- Consumes: `writeHandoff`, `setResume` from `@synergy/state`; `resolveSessionDir` (already private in execstate.ts); `tryDaemon` from `./daemon.js`.
- Produces:
  - `handoffSet(args: { root?: string; session: string; body: string; next?: string }): void` — writes `handoff.md` and updates the resume pointer to `{ nextPhase: next, note: 'See .state/handoff.md (captured …)' }`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/handoff.test.ts`:

```typescript
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProgress } from '@synergy/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handoffSet } from './execstate.js';

let root: string;
let session: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'synergy-cli-ho-'));
  session = 'demo';
  mkdirSync(join(root, '.synergy', 'sessions', session), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('handoffSet', () => {
  it('writes handoff.md and points the resume note at it', () => {
    handoffSet({ root, session, body: '## Next\nWire dual-write.\n', next: 'storage' });
    const dir = join(root, '.synergy', 'sessions', session);
    const ho = join(dir, '.state', 'handoff.md');
    expect(existsSync(ho)).toBe(true);
    expect(readFileSync(ho, 'utf8')).toContain('Wire dual-write.');
    const progress = readProgress(dir);
    expect(progress.resume.nextPhase).toBe('storage');
    expect(progress.resume.note).toContain('handoff.md');
  });

  it('throws for an unknown session', () => {
    expect(() => handoffSet({ root, session: 'nope', body: 'x' })).toThrow(/not found/);
  });
});
```

Note: `resolveSessionDir` resolves `<root>/.synergy/sessions/<session>` (confirmed against `resolveProjectPaths` — `sessionsDir = resolve(synergyDir, 'sessions')`). The test's `mkdirSync` path above matches; no adjustment needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/cli exec vitest run src/handoff.test.ts`
Expected: FAIL — `handoffSet` is not exported.

- [ ] **Step 3: Add `handoffSet` to `execstate.ts`**

In `packages/cli/src/execstate.ts`, update the top import to include `writeHandoff`:

```typescript
import {
  type StatusValue,
  appendFinding,
  deriveProgress,
  readProgress,
  setPhaseStatus,
  setResume,
  writeHandoff,
} from '@synergy/state';
```

Append:

```typescript
export interface HandoffArgs {
  root?: string;
  session: string;
  body: string;
  next?: string;
}

export function handoffSet(args: HandoffArgs): void {
  const sessionDir = resolveSessionDir(args.root, args.session);
  writeHandoff(sessionDir, args.body);
  const stamp = new Date().toISOString();
  setResume(sessionDir, {
    nextPhase: args.next,
    note: `See .state/handoff.md (captured ${stamp})`,
  });
  process.stdout.write(`${green('✓')} handoff written → ${dim('.state/handoff.md')}\n`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @synergy/cli exec vitest run src/handoff.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Register the `handoff` command in `cli.ts`**

In `packages/cli/src/cli.ts`, update the execstate import to add `handoffSet`:

```typescript
import { handoffSet, logFinding, phaseSet, printProgress, resumeSet } from './execstate.js';
```

Insert this command block immediately before `cli.parse();` at the end of the file:

```typescript
cli
  .command('handoff <session>', 'Write the KT handoff baton (.state/handoff.md) + resume pointer')
  .option('--root <dir>', 'Project root (default: cwd)')
  .option('--next <phaseId>', 'Phase slug the next agent should resume from')
  .option('--body <text>', 'Handoff markdown body (inline)')
  .option('--body-file <path>', 'Read the handoff markdown body from a file')
  .action(
    async (
      session: string,
      flags: { root?: string; next?: string; body?: string; bodyFile?: string },
    ) => {
      try {
        const body = flags.bodyFile ? readFileSync(flags.bodyFile, 'utf8') : (flags.body ?? '');
        if (!body.trim()) {
          process.stderr.write(`${red('Error:')} handoff needs --body or --body-file\n`);
          process.exit(1);
        }
        const viaDaemon = await tryDaemon(flags.root, 'POST', '/api/handoff', {
          session,
          body,
          next: flags.next,
        });
        if (viaDaemon) {
          process.stdout.write(`${green('✓')} handoff written → ${dim('.state/handoff.md')}\n`);
        } else {
          handoffSet({ root: flags.root, session, body, next: flags.next });
        }
      } catch (err) {
        process.stderr.write(`${red('Error:')} ${(err as Error).message}\n`);
        process.exit(1);
      }
    },
  );
```

`cli.ts` currently imports only from `node:path`, not `node:fs`. Add this import line at the top (below `import { resolve } from 'node:path';`):

```typescript
import { readFileSync } from 'node:fs';
```

- [ ] **Step 6: Run the full CLI test suite**

Run: `pnpm --filter @synergy/cli exec vitest run`
Expected: PASS (all existing + new).

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/execstate.ts packages/cli/src/cli.ts packages/cli/src/handoff.test.ts
git commit -m "feat(cli): add synergy handoff command"
```

---

### Task 3: Daemon route — `POST /api/handoff`

**Files:**
- Modify: `packages/preview/src/server/execstate.ts` (add `applyHandoff` + `handleHandoff`)
- Modify: `packages/preview/vite-plugin-edit.ts` (route it)
- Create: `packages/preview/src/server/handoff.test.ts`

**Interfaces:**
- Consumes: `writeHandoff`, `setResume` from `@synergy/state`; `assertSafeSession`, `readJsonBody`, `sendJson`.
- Produces:
  - `applyHandoff(sessionsDir: string, body: { session: string; body: string; next?: string }): void`
  - `handleHandoff(req, res, sessionsDir): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/preview/src/server/handoff.test.ts`:

```typescript
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProgress } from '@synergy/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyHandoff } from './execstate.js';

let sessionsDir: string;
beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'synergy-srv-ho-'));
});
afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe('applyHandoff', () => {
  it('writes handoff.md + resume note for a valid session', () => {
    applyHandoff(sessionsDir, { session: 'demo', body: '## Next\nwire it', next: 'storage' });
    const dir = join(sessionsDir, 'demo');
    expect(existsSync(join(dir, '.state', 'handoff.md'))).toBe(true);
    expect(readFileSync(join(dir, '.state', 'handoff.md'), 'utf8')).toContain('wire it');
    expect(readProgress(dir).resume.note).toContain('handoff.md');
  });

  it('rejects an unsafe session name', () => {
    expect(() => applyHandoff(sessionsDir, { session: '../evil', body: 'x' })).toThrow(/invalid session/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/preview exec vitest run src/server/handoff.test.ts`
Expected: FAIL — `applyHandoff` not exported.

- [ ] **Step 3: Add `applyHandoff` + `handleHandoff` to server `execstate.ts`**

In `packages/preview/src/server/execstate.ts`, update the `@synergy/state` import to add `setResume` (already imported) and `writeHandoff`:

```typescript
import { type StatusValue, appendFinding, setPhaseStatus, setResume, writeHandoff } from '@synergy/state';
```

Append at the end of the file:

```typescript
export function applyHandoff(
  sessionsDir: string,
  body: { session: string; body: string; next?: string },
): void {
  assertSafeSession(body.session);
  const sessionDir = join(sessionsDir, body.session);
  writeHandoff(sessionDir, body.body);
  setResume(sessionDir, {
    nextPhase: body.next,
    note: `See .state/handoff.md (captured ${new Date().toISOString()})`,
  });
}

export async function handleHandoff(
  req: IncomingMessage,
  res: ServerResponse,
  sessionsDir: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  if (!isRecord(body) || typeof body.session !== 'string' || typeof body.body !== 'string') {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: 'session and body are required strings',
    });
    return;
  }
  try {
    applyHandoff(sessionsDir, {
      session: body.session,
      body: body.body,
      next: typeof body.next === 'string' ? body.next : undefined,
    });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @synergy/preview exec vitest run src/server/handoff.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Route it in `vite-plugin-edit.ts`**

In `packages/preview/vite-plugin-edit.ts`, extend the execstate import (line ~17):

```typescript
import { handleHandoff, handleLog, handlePhase, handleResume } from './src/server/execstate.js';
```

Immediately after the `POST /api/resume` block (search for `pathname === '/api/resume'`), add:

```typescript
          // POST /api/handoff — write the KT handoff baton + resume pointer
          if (method === 'POST' && pathname === '/api/handoff') {
            await handleHandoff(req, res, sessionsDir);
            return;
          }
```

- [ ] **Step 6: Run the full preview test suite**

Run: `pnpm --filter @synergy/preview exec vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/preview/src/server/execstate.ts packages/preview/vite-plugin-edit.ts packages/preview/src/server/handoff.test.ts
git commit -m "feat(preview): add POST /api/handoff daemon route"
```

---

### Task 4: `/synergy-handoff` command + `synergy:handoff` skill

**Files:**
- Create: `commands/synergy-handoff.md`
- Create: `skills/handoff/SKILL.md`

**Interfaces:**
- Consumes: `synergy handoff` CLI / `POST /api/handoff` from Tasks 2–3.
- Produces: a user-invocable `/synergy-handoff` command dispatching to the `synergy:handoff` skill.

- [ ] **Step 1: Create the command file**

Create `commands/synergy-handoff.md` (mirror `commands/synergy-continue.md`):

```markdown
---
description: Capture a knowledge-transfer handoff for the active Synergy session before quitting
argument-hint: [session] [directives...]
---

Invoke the `synergy:handoff` skill to snapshot the current session's knowledge so a future agent can pick up exactly where you left off.

The user's request: `$ARGUMENTS`
```

- [ ] **Step 2: Create the skill**

Create `skills/handoff/SKILL.md`. Copy the Step-0 freshness block verbatim from `skills/continue/SKILL.md` (lines 1–25 including the `synergy-version` marker — `version-sync` will fix the number), then the body below:

````markdown
# handoff

Capture the current session's knowledge into `.state/handoff.md` so a future agent
resumes exactly where you stopped — even mid-phase. You (the live agent) author the
snapshot from your own context.

CLI base: `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js"`.

## Steps

**1. Resolve the session** — same as `synergy:execute` step 1 (`$ARGUMENTS` first token, else
`.synergy/active-session` within the 10-minute window, else ask).

**2. Author the handoff snapshot** from your own working context. Fill every section;
"none" is a valid value:

```markdown
## What I did this session
## In-flight / half-done   (files touched but not complete; what's missing)
## Next concrete step       (the single first action the next agent should take)
## Gotchas / dead-ends      (what NOT to retry, surprising constraints)
## Open questions           (decisions deferred to a human)
## Current phase state      (phaseId + rough %; e.g. "storage ~60%")
```

Reference the phase by its **slug** (e.g. `storage`), never a file path like
`phases/01-storage/spec.mdx` — numeric prefixes are sort-order, not identity, and rot
under renumbering. Carry knowledge + slug only; the resuming agent resolves the spec path
from the slug via the fixed layout convention. Do not embed `spec:`/`orchestrator:` links.

**3. Write it.** Prefer the daemon; fall back to the CLI. Write the body to a temp file to
avoid shell-escaping a large multi-line dump:

```bash
BODY_FILE="$(mktemp)"
cat > "$BODY_FILE" <<'EOF'
## What I did this session
…
## Current phase state
storage ~60%
EOF

# Fast path (daemon running):
curl -sS -X POST http://localhost:4321/api/handoff \
  -H 'content-type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"session":sys.argv[1],"next":sys.argv[2],"body":open(sys.argv[3]).read()}))' "<session>" "<nextPhaseId>" "$BODY_FILE")"

# Fallback (preview not running):
node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" handoff <session> --next <nextPhaseId> --body-file "$BODY_FILE"
```

**4. Confirm** the path (`.state/handoff.md`) and resume pointer back to the user. It is now
safe to quit — a future `/synergy-continue` or `/synergy-execute` will read this first.

## Don'ts
- Don't hand-edit `.state/handoff.md` — always go through the CLI/daemon.
- Don't omit "Next concrete step" or "Current phase state" — those are what let a fresh
  agent resume mid-phase instead of restarting it.
- Don't delete the prior handoff — `writeHandoff` overwrites it (latest-wins).
````

- [ ] **Step 3: Verify skill/command files parse**

Run: `node "packages/cli/dist/cli.js" handoff --help 2>&1 | head -5` (after `pnpm --filter @synergy/cli build`)
Expected: usage text listing `--next`, `--body`, `--body-file`.

- [ ] **Step 4: Commit**

```bash
git add commands/synergy-handoff.md skills/handoff/SKILL.md
git commit -m "feat(plugin): add /synergy-handoff command + skill"
```

---

### Task 5: Patch `execute` + `continue` for tiered, lazy handoff ingestion

**Files:**
- Modify: `skills/continue/SKILL.md` (add handoff as first read in step 2)
- Modify: `skills/execute/SKILL.md` (add handoff first read + mid-phase resume rule; journals conditional; spec stays lazy)

**Interfaces:**
- Consumes: `.state/handoff.md` written by Tasks 1–4.

Read order is **tiered** so the opening context stays small — handoff is the router;
journals are conditional; the phase spec is lazy (pulled per-phase at implement-time, never
front-loaded):

| Tier | File(s) | When |
|---|---|---|
| Always, first | `handoff.md` | every resume — the router |
| Always | resume pointer / `status` | every resume |
| Conditional | `phases/<slug>.md`, `journal.md` | only when the handoff routes you into a phase needing backstory |
| Lazy | `spec.mdx` (one phase) | only at implement-time, after a phase is picked |
| On-demand | `orchestrator.md` | only when strategy is needed |

- [ ] **Step 1: Patch `continue` skill**

In `skills/continue/SKILL.md`, in **step 2 "Load the hand-off (state first)"**, insert this as the FIRST bullet (before the resume-pointer bullet):

```markdown
- **Read `.synergy/sessions/<session>/.state/handoff.md` first** if it exists — the latest
  brain-dump from the agent that just stopped (what's half-done, the next concrete step,
  gotchas, current phase slug). This is your primary starting instruction and router; pull
  the resume pointer + journals below only for the phase it points you into.
```

Leave `continue`'s existing spec read as-is — it already scopes to the resume phase and
reads it at work-time, not upfront. Do not broaden it.

- [ ] **Step 2: Patch `execute` skill**

In `skills/execute/SKILL.md`, in **step 2 "Read state first, then strategy, then detail"**,
insert these as the FIRST bullets (before the `synergy status` bullet). `execute` today
ingests **neither** the handoff nor the journals; add the handoff as the always-first read
and make the journals **conditional**, not an upfront slurp:

```markdown
- **Read `.synergy/sessions/<session>/.state/handoff.md` first** if it exists. It is the
  latest KT baton (overwrite/latest-wins — a single current snapshot, not a log) and your
  router. If it names an in-progress phase in "Current phase state", **resume that phase
  from its "Next concrete step" — do not restart it from scratch.** This closes the
  mid-phase gap where a phase is `in-progress` with no boundary note.
- **Pull history conditionally.** When the handoff routes you into a phase, read that
  phase's log `.state/phases/<slug>.md` and — only if you need cross-cutting context —
  `.state/journal.md`. These are the append-only backstory behind the handoff snapshot.
  Handoff = "you are here"; journals = the backstory; KT is the two together. Do not read
  the journals unconditionally at orientation.
```

- [ ] **Step 2b: Preserve lazy, per-phase spec reads**

In `skills/execute/SKILL.md` step 2, confirm the existing spec bullet still reads only the
**relevant** phase's `spec.mdx` (not all phases) and only when implementing that phase.
Add an explicit note so it is not "improved" into an upfront read:

```markdown
- The handoff routes; the phase `spec.mdx` is pulled **lazily** — only the phase you are
  about to implement, at implement-time. Never front-load all phase specs.
```

- [ ] **Step 3: Bump the plugin version**

Both skills carry a `synergy-version` marker; `version-sync` derives it from `plugin.json`. Bump the source of truth:

Edit `.claude-plugin/plugin.json` — change `"version"` from `0.8.1` to `0.9.0` (new user-facing feature → minor bump).

- [ ] **Step 4: Verify the version-sync guard is satisfied**

Run: `git add -A && pnpm --filter @synergy/plugin-guard exec node dist/version-sync.js 2>/dev/null || true` then `git status`
Expected: `synergy-version` markers in the edited SKILL.md files and `marketplace.json` now read `0.9.0` (lefthook also does this on commit; running it here avoids a surprise). If the exact command differs, rely on the lefthook `version-sync` hook firing on commit.

- [ ] **Step 5: Commit**

```bash
git add skills/continue/SKILL.md skills/execute/SKILL.md .claude-plugin/plugin.json
git commit -m "feat(skills): read handoff.md first in execute + continue; bump 0.9.0"
```

---

### Task 6: Docs — CLAUDE.md command + daemon-API table

**Files:**
- Modify: `CLAUDE.md` (command list, daemon-API table, execution-state section)

**Interfaces:** none (documentation).

- [ ] **Step 1: Add the CLI command to the two command lists**

In `CLAUDE.md`, in BOTH the "Execution state and hand-off (v3)" CLI block and the top-level "## Commands" block, add:

```
synergy handoff <session> [--next <id>] [--body <text> | --body-file <path>]   write the KT handoff baton (.state/handoff.md) + resume pointer
```

- [ ] **Step 2: Add the daemon-API row**

In the "Daemon HTTP API" table, add a row after the `/api/resume` row:

```
| `POST /api/handoff` | `synergy handoff` | `{session, body, next?}` |
```

- [ ] **Step 3: Document the artifact + slash command**

In the "Execution state and hand-off (v3)" section, add a bullet:

```markdown
- `handoff.md` — a latest-wins KT baton written by `/synergy-handoff` when you stop
  mid-work. Both `synergy:execute` and `synergy:continue` read it FIRST; it carries
  sub-phase state (what's half-done, the next concrete step) that the phase-gated journals
  miss. Overwritten on each capture; git-committed like the rest of `.state/`.
```

Add `/synergy-handoff` to the Claude Code slash-commands list in the "## Commands" section.

- [ ] **Step 4: Verify no other doc references are stale**

Run: `grep -rn "api/resume" CLAUDE.md` and confirm the new handoff row sits directly below it.
Expected: both rows present and adjacent.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document handoff.md artifact, CLI + daemon surface"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Build all packages**

Run: `pnpm -r run build`
Expected: all packages build clean (no TS errors).

- [ ] **Step 2: Run all tests**

Run: `pnpm -r run test`
Expected: all package suites PASS, including the three new test files.

- [ ] **Step 3: End-to-end dogfood in `examples/`**

Run:
```bash
cd examples
node ../packages/cli/dist/cli.js handoff refactor-auth --next storage --body '## Next concrete step
Wire dual-write in TokenStore.
## Current phase state
storage ~60%'
cat .synergy/sessions/refactor-auth/.state/handoff.md
node ../packages/cli/dist/cli.js status refactor-auth
```
Expected: `handoff.md` contains the timestamped heading + body; `status` shows `next: storage — See .state/handoff.md (captured …)`.

- [ ] **Step 4: Clean up the dogfood artifact**

Run: `cd examples && git checkout .synergy/sessions/refactor-auth/.state/ 2>/dev/null || rm -f .synergy/sessions/refactor-auth/.state/handoff.md`
Expected: the example session's committed state is restored (do not commit a throwaway handoff into the example).

- [ ] **Step 5: Final commit (if any doc/version drift remains)**

```bash
git status
# commit only if version-sync left uncommitted derived files
```

---

## Self-Review

**Spec coverage:**
- Dedicated latest-wins `handoff.md` → Task 1. ✅
- `writeHandoff`/`readHandoff`/`handoffPath` → Task 1. ✅
- Resume pointer updated to point at handoff → Tasks 2 & 3. ✅
- `synergy handoff` CLI verb (`--body`/`--body-file`/`--next`, daemon fast-path + fallback) → Task 2. ✅
- `POST /api/handoff` daemon route (parity with CLI) → Task 3. ✅
- `/synergy-handoff` skill + command, agent self-authors template → Task 4. ✅
- `execute` + `continue` tiered ingestion: handoff always-first (router), journals conditional, spec lazy per-phase; execute mid-phase resume rule → Task 5. ✅
- Git-committed, backward-compatible (null when absent) → Tasks 1 & 5. ✅
- Release/freshness version bump → Task 5. ✅
- CLAUDE.md command list + daemon table → Task 6. ✅
- Non-goal (no transcript scraping, no structured fields) respected — snapshot is free-form markdown authored by the agent. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code. One flagged uncertainty (exact sessions path in Task 2 test; exact version-sync invocation in Task 5) is called out with a concrete fallback, not left blank.

**Type consistency:** `writeHandoff(sessionDir, body, now?)`, `readHandoff(sessionDir)`, `handoffPath(sessionDir)`, `handoffSet({root,session,body,next})`, `applyHandoff(sessionsDir,{session,body,next})`, `handleHandoff(req,res,sessionsDir)` — names + signatures match across Tasks 1–3 and their call sites in Tasks 4–6. Body field is consistently named `body`; next-phase is consistently `next` (CLI/daemon) mapping to `resume.nextPhase`. ✅
