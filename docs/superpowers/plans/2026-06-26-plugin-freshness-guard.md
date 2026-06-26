# Plugin Freshness Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee users run the latest Synergy plugin *behavior* after an update, by guarding three failure modes: a stale running session, a behavior change shipped without a version bump, and a user who never updates.

**Architecture:** One version source of truth (`.claude-plugin/plugin.json`) is stamped into `marketplace.json` and every authoring `SKILL.md` by a `version-sync` tool (auto-run by lefthook pre-commit). A CI gate on `main` blocks any behavior-dir change without a bump or with inconsistent stamps. At runtime, a pure-bash `SessionStart` hook warns when the session resolved an older version than is installed, and an inline "Step 0" in the authoring skills warns at point-of-use. All runtime guards are **warn-and-proceed** and **fix-forward** (effective from 0.7.0 onward).

**Tech Stack:** TypeScript (strict) + vitest for author-side tooling (`packages/plugin-guard`), run in dev/CI via `tsx`; pure POSIX bash for the runtime hook; lefthook for git hooks; GitHub Actions for CI.

## Global Constraints

- pnpm workspaces; use `pnpm`, never `npm`/`yarn`. (verbatim from CLAUDE.md)
- TypeScript everywhere, strict mode on — author-side tooling is TS. The runtime hook is bash *by design* (must run before `pnpm build` has produced `dist/`; the whole plugin's `dist/` is gitignored and built post-install via `synergy-setup`).
- Source of truth for version = `.claude-plugin/plugin.json` `version`. `marketplace.json` and SKILL.md stamps are **derived, never hand-edited**.
- Behavior dirs (a change here requires a version bump): `skills/`, `packages/`, `commands/`, `hooks/`. Explicitly non-behavioral (no bump required): `examples/`, `docs/`.
- Plugin cache path: `${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}/cache/synergy/synergy/<version>/`.
- Runtime guards fail **open**: any error (missing dir, parse failure, network timeout) produces no warning, never an error or block.
- Staleness comparison uses `sort -V` semantics; downgrades (`mine > newest`) are NOT stale; `0.9.0 < 0.10.0`.
- Stale-session warning copy (verbatim): `⚠ synergy: this session loaded v<MINE>, but v<NEWEST> is installed. Restart Claude Code to load the latest skills/templates.`
- This change itself ships as `0.6.0 → 0.7.0`.
- No `Co-Authored-By` trailer on commits (user preference).

## File Structure

**New — `packages/plugin-guard/` (TS, author-side, run via `tsx`; vitest tests):**
- `package.json` — `@synergy/plugin-guard`, private, `test`/`typecheck` scripts.
- `tsconfig.json` — extends repo base.
- `src/versions.ts` — `compareVersions`, `newest`, `isStale` (pure).
- `src/changed.ts` — `BEHAVIOR_DIRS`, `NON_BEHAVIOR_DIRS`, `requiresBump` (pure).
- `src/stamp.ts` — `syncText` helpers: rewrite marketplace.json version + SKILL.md stamp in a string (pure, no I/O).
- `src/version-sync.ts` — CLI: stamp files on disk; `--check` mode asserts consistency without writing.
- `src/check-bump.ts` — CLI: given base/head versions + changed paths, exit non-zero if a bump is required but absent.
- `tests/versions.test.ts`, `tests/changed.test.ts`, `tests/stamp.test.ts`, `tests/version-sync.test.ts`, `tests/hook.test.ts`.

**New — runtime hook (bash, shipped, no build):**
- `hooks/hooks.json` — registers the `SessionStart` command.
- `hooks/session-start.sh` — freshness check + best-effort upstream nudge.

**Modified:**
- `lefthook.yml` — add `version-sync` pre-commit command (via `tsx`, `stage_fixed: true`).
- `.github/workflows/ci.yml` — add `release-gate` job (`fetch-depth: 0`).
- `skills/create-spec/SKILL.md`, `skills/execute/SKILL.md`, `skills/spec-authoring/SKILL.md`, `skills/resume/SKILL.md` — add `<!-- synergy-version: X -->` stamp + "Step 0 — Freshness check".
- `.claude-plugin/plugin.json` — bump to `0.7.0`.
- `.claude-plugin/marketplace.json` — `0.7.0` (written by version-sync).
- `package.json` (root) — add `tsx` devDependency; add `test:guard`/aggregate if needed.
- `pnpm-lock.yaml` — updated by `pnpm install`.
- `CLAUDE.md` — short "Release & freshness" subsection.

---

### Task 1: `@synergy/plugin-guard` package + version comparison

**Files:**
- Create: `packages/plugin-guard/package.json`, `packages/plugin-guard/tsconfig.json`
- Create: `packages/plugin-guard/src/versions.ts`
- Test: `packages/plugin-guard/tests/versions.test.ts`

**Interfaces:**
- Produces: `compareVersions(a: string, b: string): -1 | 0 | 1`; `newest(versions: string[]): string | null`; `isStale(mine: string, installed: string[]): boolean`.

- [ ] **Step 1: Scaffold the package**

`packages/plugin-guard/package.json`:
```json
{
  "name": "@synergy/plugin-guard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Release-time + runtime freshness guard tooling for the Synergy plugin.",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "22.10.1",
    "typescript": "5.6.3",
    "vitest": "2.1.5"
  }
}
```

`packages/plugin-guard/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "tests"]
}
```

- [ ] **Step 2: Write the failing test**

`packages/plugin-guard/tests/versions.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { compareVersions, isStale, newest } from '../src/versions.js';

describe('compareVersions', () => {
  it('orders by semver, not lexically', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.6.0', '0.6.0')).toBe(0);
  });
});

describe('newest', () => {
  it('returns the highest semver or null on empty', () => {
    expect(newest(['0.3.0', '0.10.0', '0.6.0'])).toBe('0.10.0');
    expect(newest([])).toBeNull();
  });
});

describe('isStale', () => {
  it('is true only when a strictly newer version is installed', () => {
    expect(isStale('0.5.0', ['0.3.0', '0.5.0', '0.6.0'])).toBe(true);
    expect(isStale('0.6.0', ['0.3.0', '0.6.0'])).toBe(false); // newest
    expect(isStale('0.7.0', ['0.6.0'])).toBe(false); // downgrade case
    expect(isStale('0.6.0', [])).toBe(false); // nothing installed
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `pnpm --filter @synergy/plugin-guard exec vitest run tests/versions.test.ts`
Expected: FAIL — cannot find module `../src/versions.js`.

- [ ] **Step 4: Implement**

`packages/plugin-guard/src/versions.ts`:
```ts
/** Compare two dotted numeric versions. Returns -1, 0, or 1. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** Highest version in the list, or null when empty. */
export function newest(versions: string[]): string | null {
  if (versions.length === 0) return null;
  return versions.reduce((hi, v) => (compareVersions(v, hi) > 0 ? v : hi));
}

/** True when a strictly newer version than `mine` is installed. */
export function isStale(mine: string, installed: string[]): boolean {
  const hi = newest(installed);
  return hi !== null && compareVersions(mine, hi) < 0;
}
```

- [ ] **Step 5: Install deps + run test, verify it passes**

Run: `pnpm install && pnpm --filter @synergy/plugin-guard exec vitest run tests/versions.test.ts`
Expected: PASS (3 files / suites green).

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-guard pnpm-lock.yaml
git commit -m "feat(plugin-guard): semver compare + staleness logic"
```

---

### Task 2: Changed-path → bump-required classification

**Files:**
- Create: `packages/plugin-guard/src/changed.ts`
- Test: `packages/plugin-guard/tests/changed.test.ts`

**Interfaces:**
- Produces: `BEHAVIOR_DIRS: string[]`; `requiresBump(changedPaths: string[]): boolean` — true iff any path is under a behavior dir.

- [ ] **Step 1: Write the failing test**

`packages/plugin-guard/tests/changed.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { requiresBump } from '../src/changed.js';

describe('requiresBump', () => {
  it('is true when a behavior dir changed', () => {
    expect(requiresBump(['skills/create-spec/SKILL.md'])).toBe(true);
    expect(requiresBump(['packages/spec-kit/src/x.ts'])).toBe(true);
    expect(requiresBump(['commands/foo.md'])).toBe(true);
    expect(requiresBump(['hooks/session-start.sh'])).toBe(true);
  });
  it('is false for non-behavioral changes only', () => {
    expect(requiresBump(['docs/x.md', 'examples/y.mdx', 'README.md'])).toBe(false);
    expect(requiresBump([])).toBe(false);
  });
  it('is true when behavior + non-behavior changes are mixed', () => {
    expect(requiresBump(['docs/x.md', 'skills/execute/SKILL.md'])).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @synergy/plugin-guard exec vitest run tests/changed.test.ts`
Expected: FAIL — cannot find `../src/changed.js`.

- [ ] **Step 3: Implement**

`packages/plugin-guard/src/changed.ts`:
```ts
/** Directories whose change requires a plugin version bump. */
export const BEHAVIOR_DIRS = ['skills/', 'packages/', 'commands/', 'hooks/'] as const;

/** True when any changed path lives under a behavior dir. */
export function requiresBump(changedPaths: string[]): boolean {
  return changedPaths.some((p) => BEHAVIOR_DIRS.some((d) => p.startsWith(d)));
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @synergy/plugin-guard exec vitest run tests/changed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-guard/src/changed.ts packages/plugin-guard/tests/changed.test.ts
git commit -m "feat(plugin-guard): classify changed paths as bump-requiring"
```

---

### Task 3: Stamp rewriter + `version-sync` CLI

**Files:**
- Create: `packages/plugin-guard/src/stamp.ts`, `packages/plugin-guard/src/version-sync.ts`
- Test: `packages/plugin-guard/tests/stamp.test.ts`, `packages/plugin-guard/tests/version-sync.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `setMarketplaceVersion(json: string, version: string): string`; `setSkillStamp(md: string, version: string): string`; `SKILL_STAMP_RE`. CLI `version-sync` writes `.claude-plugin/marketplace.json` + `skills/*/SKILL.md`; `version-sync --check` exits 1 on drift.
- Stamp format (verbatim, one per stamped SKILL.md, immediately after the closing frontmatter `---`): `<!-- synergy-version: X.Y.Z -->`

- [ ] **Step 1: Write the failing test (pure rewriters)**

`packages/plugin-guard/tests/stamp.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { setMarketplaceVersion, setSkillStamp } from '../src/stamp.js';

describe('setMarketplaceVersion', () => {
  it('rewrites the version field, preserving formatting', () => {
    const input = '{\n  "plugins": [\n    { "name": "synergy", "version": "0.6.0" }\n  ]\n}\n';
    expect(setMarketplaceVersion(input, '0.7.0')).toContain('"version": "0.7.0"');
  });
});

describe('setSkillStamp', () => {
  it('updates an existing stamp', () => {
    const md = '---\nname: x\n---\n<!-- synergy-version: 0.6.0 -->\n\nbody\n';
    expect(setSkillStamp(md, '0.7.0')).toContain('<!-- synergy-version: 0.7.0 -->');
  });
  it('inserts a stamp after frontmatter when missing', () => {
    const md = '---\nname: x\n---\n\nbody\n';
    const out = setSkillStamp(md, '0.7.0');
    expect(out).toMatch(/---\n<!-- synergy-version: 0.7.0 -->/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @synergy/plugin-guard exec vitest run tests/stamp.test.ts`
Expected: FAIL — cannot find `../src/stamp.js`.

- [ ] **Step 3: Implement the rewriters**

`packages/plugin-guard/src/stamp.ts`:
```ts
export const SKILL_STAMP_RE = /<!-- synergy-version: [^>]*-->/;

/** Rewrite the first `"version": "..."` in a marketplace.json string. */
export function setMarketplaceVersion(json: string, version: string): string {
  return json.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);
}

/** Update the SKILL.md stamp, or insert one right after the frontmatter. */
export function setSkillStamp(md: string, version: string): string {
  const stamp = `<!-- synergy-version: ${version} -->`;
  if (SKILL_STAMP_RE.test(md)) return md.replace(SKILL_STAMP_RE, stamp);
  // Insert after the closing frontmatter delimiter (second `---`).
  const fm = md.match(/^---\n[\s\S]*?\n---\n/);
  if (!fm) return md; // no frontmatter — leave untouched
  const end = fm[0].length;
  return `${md.slice(0, end)}${stamp}\n${md.slice(end)}`;
}
```

- [ ] **Step 4: Run rewriter test, verify it passes**

Run: `pnpm --filter @synergy/plugin-guard exec vitest run tests/stamp.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing CLI test (I/O against a temp dir)**

`packages/plugin-guard/tests/version-sync.test.ts`:
```ts
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/version-sync.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'synguard-'));
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'skills/create-spec'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ version: '0.7.0' }));
  writeFileSync(
    join(root, '.claude-plugin/marketplace.json'),
    '{\n  "plugins": [\n    { "name": "synergy", "version": "0.6.0" }\n  ]\n}\n',
  );
  writeFileSync(
    join(root, 'skills/create-spec/SKILL.md'),
    '---\nname: create-spec\n---\n<!-- synergy-version: 0.6.0 -->\n\nbody\n',
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('version-sync', () => {
  it('--check reports drift with a non-zero code', () => {
    expect(run(['--check'], root)).toBe(1);
  });
  it('writes the plugin.json version into all derived files', () => {
    expect(run([], root)).toBe(0);
    expect(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8')).toContain('"version": "0.7.0"');
    expect(readFileSync(join(root, 'skills/create-spec/SKILL.md'), 'utf8')).toContain('synergy-version: 0.7.0');
    expect(run(['--check'], root)).toBe(0); // now consistent
  });
});
```

- [ ] **Step 6: Run CLI test, verify it fails**

Run: `pnpm --filter @synergy/plugin-guard exec vitest run tests/version-sync.test.ts`
Expected: FAIL — cannot find `../src/version-sync.js`.

- [ ] **Step 7: Implement the CLI**

`packages/plugin-guard/src/version-sync.ts`:
```ts
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setMarketplaceVersion, setSkillStamp } from './stamp.js';

interface Target {
  path: string;
  read(): string;
  rewrite(content: string, version: string): string;
}

function targets(root: string): Target[] {
  const out: Target[] = [
    {
      path: join(root, '.claude-plugin/marketplace.json'),
      read() {
        return readFileSync(this.path, 'utf8');
      },
      rewrite: setMarketplaceVersion,
    },
  ];
  const skillsDir = join(root, 'skills');
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(skillsDir, entry.name, 'SKILL.md');
    let content: string;
    try {
      content = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    // Only stamp skills that already opt in (carry the marker).
    if (!content.includes('synergy-version:')) continue;
    out.push({ path: p, read: () => readFileSync(p, 'utf8'), rewrite: setSkillStamp });
  }
  return out;
}

/** Returns process exit code. `--check` never writes; non-zero means drift. */
export function run(argv: string[], root: string = process.cwd()): number {
  const check = argv.includes('--check');
  const version = (JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')) as { version: string })
    .version;
  let drift = false;
  for (const t of targets(root)) {
    const current = t.read();
    const next = t.rewrite(current, version);
    if (next !== current) {
      drift = true;
      if (!check) writeFileSync(t.path, next);
    }
  }
  if (check && drift) {
    process.stderr.write(`version-sync: files are out of sync with plugin.json (${version}). Run version-sync.\n`);
    return 1;
  }
  return 0;
}

// CLI entry (tsx / node). import.meta.url guard keeps it importable in tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  process.exit(run(process.argv.slice(2)));
}
```

- [ ] **Step 8: Run CLI test, verify it passes**

Run: `pnpm --filter @synergy/plugin-guard exec vitest run tests/version-sync.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/plugin-guard/src/stamp.ts packages/plugin-guard/src/version-sync.ts packages/plugin-guard/tests/stamp.test.ts packages/plugin-guard/tests/version-sync.test.ts
git commit -m "feat(plugin-guard): version-sync stamper with --check mode"
```

---

### Task 4: Wire `version-sync` into lefthook pre-commit

**Files:**
- Modify: `lefthook.yml`
- Modify: `package.json` (root) — add `tsx` devDependency

**Interfaces:**
- Consumes: `packages/plugin-guard/src/version-sync.ts` (run via `tsx`).

- [ ] **Step 1: Add `tsx` to root devDependencies**

Run:
```bash
pnpm add -Dw tsx
```
Expected: `tsx` added to root `package.json` devDependencies; lockfile updated.

- [ ] **Step 2: Add the pre-commit command**

Modify `lefthook.yml` — add under `pre-commit.commands` (alongside `biome`):
```yaml
    version-sync:
      glob: "{.claude-plugin/plugin.json,.claude-plugin/marketplace.json,skills/**/SKILL.md}"
      run: pnpm exec tsx packages/plugin-guard/src/version-sync.ts
      stage_fixed: true
```

- [ ] **Step 3: Verify it runs and is a no-op when in sync**

Run:
```bash
pnpm exec tsx packages/plugin-guard/src/version-sync.ts && echo "sync OK (exit $?)"
git diff --quiet && echo "no changes — in sync"
```
Expected: prints `sync OK (exit 0)` and `no changes — in sync` (plugin.json still 0.6.0 at this point, marketplace already 0.6.0; skills not yet stamped so they're skipped).

- [ ] **Step 4: Commit**

```bash
git add lefthook.yml package.json pnpm-lock.yaml
git commit -m "build: run version-sync on pre-commit via lefthook"
```

---

### Task 5: `check-bump` CLI + CI release-gate job

**Files:**
- Create: `packages/plugin-guard/src/check-bump.ts`
- Test: extend `packages/plugin-guard/tests/changed.test.ts` with a `shouldFail` table
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `requiresBump` (Task 2), `compareVersions` (Task 1).
- Produces: `shouldFail({ baseVersion, headVersion, changedPaths }): { fail: boolean; reason?: string }`; CLI reading `BASE_REF`/`HEAD_REF` env + `git` to compute inputs.

- [ ] **Step 1: Write the failing test**

Append to `packages/plugin-guard/tests/changed.test.ts`:
```ts
import { shouldFail } from '../src/check-bump.js';

describe('shouldFail', () => {
  const base = '0.6.0';
  it('fails when a behavior dir changed but version did not increase', () => {
    expect(shouldFail({ baseVersion: base, headVersion: '0.6.0', changedPaths: ['skills/x/SKILL.md'] }).fail).toBe(true);
  });
  it('passes when the version increased', () => {
    expect(shouldFail({ baseVersion: base, headVersion: '0.7.0', changedPaths: ['skills/x/SKILL.md'] }).fail).toBe(false);
  });
  it('passes when only non-behavioral files changed', () => {
    expect(shouldFail({ baseVersion: base, headVersion: '0.6.0', changedPaths: ['docs/x.md'] }).fail).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @synergy/plugin-guard exec vitest run tests/changed.test.ts`
Expected: FAIL — cannot find `../src/check-bump.js`.

- [ ] **Step 3: Implement**

`packages/plugin-guard/src/check-bump.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { compareVersions } from './versions.js';
import { requiresBump } from './changed.js';

export interface BumpInput {
  baseVersion: string;
  headVersion: string;
  changedPaths: string[];
}

export function shouldFail(input: BumpInput): { fail: boolean; reason?: string } {
  if (!requiresBump(input.changedPaths)) return { fail: false };
  if (compareVersions(input.headVersion, input.baseVersion) > 0) return { fail: false };
  return {
    fail: true,
    reason: `Behavior changed (skills/packages/commands/hooks) but plugin.json version stayed ${input.headVersion}. Bump it.`,
  };
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function versionAt(ref: string): string {
  const json = git(['show', `${ref}:.claude-plugin/plugin.json`]);
  return (JSON.parse(json) as { version: string }).version;
}

// CLI: BASE_REF + HEAD_REF env (default origin/main...HEAD). Exit 1 on violation.
if (process.argv[1]?.endsWith('check-bump.ts') || process.argv[1]?.endsWith('check-bump.js')) {
  const base = process.env.BASE_REF ?? 'origin/main';
  const head = process.env.HEAD_REF ?? 'HEAD';
  const changedPaths = git(['diff', '--name-only', `${base}...${head}`]).split('\n').filter(Boolean);
  const result = shouldFail({ baseVersion: versionAt(base), headVersion: versionAt(head), changedPaths });
  if (result.fail) {
    process.stderr.write(`check-bump: ${result.reason}\n`);
    process.exit(1);
  }
  process.stdout.write('check-bump: OK\n');
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @synergy/plugin-guard exec vitest run tests/changed.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the CI job**

Modify `.github/workflows/ci.yml` — append a second job:
```yaml
  release-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
        with:
          version: 10.28.2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Stamp consistency
        run: pnpm exec tsx packages/plugin-guard/src/version-sync.ts --check
      - name: Version bump required for behavior changes
        env:
          BASE_REF: origin/${{ github.base_ref || 'main' }}
          HEAD_REF: HEAD
        run: |
          git fetch origin "${{ github.base_ref || 'main' }}" --depth=1 || true
          pnpm exec tsx packages/plugin-guard/src/check-bump.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-guard/src/check-bump.ts packages/plugin-guard/tests/changed.test.ts .github/workflows/ci.yml
git commit -m "feat(plugin-guard): CI gate — no behavior change without a version bump"
```

---

### Task 6: SessionStart hook (pure bash)

**Files:**
- Create: `hooks/hooks.json`, `hooks/session-start.sh`
- Test: `packages/plugin-guard/tests/hook.test.ts`

**Interfaces:**
- Consumes: env `CLAUDE_PLUGIN_ROOT` (path ends `…/synergy/<version>/`), optional `CLAUDE_PLUGINS_DIR`.
- Produces: stdout warning when stale; silent otherwise; always exit 0.

- [ ] **Step 1: Write the failing test**

`packages/plugin-guard/tests/hook.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const hook = resolve(__dirname, '../../../hooks/session-start.sh');
let plugins: string;

function makeCache(versions: string[]) {
  for (const v of versions) mkdirSync(join(plugins, 'cache/synergy/synergy', v), { recursive: true });
}
function runHook(mineVersion: string): string {
  const root = join(plugins, 'cache/synergy/synergy', mineVersion);
  return execFileSync('bash', [hook], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGINS_DIR: plugins, SYNERGY_SKIP_UPSTREAM: '1' },
  });
}

beforeEach(() => {
  plugins = mkdtempSync(join(tmpdir(), 'synplugins-'));
});
afterEach(() => rmSync(plugins, { recursive: true, force: true }));

describe('session-start hook', () => {
  it('warns when a newer version is installed', () => {
    makeCache(['0.5.0', '0.6.0']);
    expect(runHook('0.5.0')).toContain('Restart Claude Code');
  });
  it('is silent when running the newest', () => {
    makeCache(['0.5.0', '0.6.0']);
    expect(runHook('0.6.0').trim()).toBe('');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @synergy/plugin-guard exec vitest run tests/hook.test.ts`
Expected: FAIL — `hooks/session-start.sh` does not exist.

- [ ] **Step 3: Implement the hook script**

`hooks/session-start.sh`:
```bash
#!/usr/bin/env bash
# Synergy freshness guard. Fails open: any error => no output, exit 0.
set -u

plugins="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}"
cache="$plugins/cache/synergy/synergy"
root="${CLAUDE_PLUGIN_ROOT:-}"

mine="$(basename "$root" 2>/dev/null)"
[ -d "$cache" ] || exit 0
[ -n "$mine" ] || exit 0

newest="$(ls "$cache" 2>/dev/null | sort -V | tail -1)"
[ -n "$newest" ] || exit 0

if [ "$newest" != "$mine" ] && \
   [ "$(printf '%s\n%s\n' "$mine" "$newest" | sort -V | tail -1)" = "$newest" ]; then
  printf '⚠ synergy: this session loaded v%s, but v%s is installed. Restart Claude Code to load the latest skills/templates.\n' "$mine" "$newest"
fi

# Best-effort upstream nudge: never blocks, 3s cap, silent on any failure.
if [ -z "${SYNERGY_SKIP_UPSTREAM:-}" ] && command -v git >/dev/null 2>&1; then
  upstream="$(timeout 3 git ls-remote --tags https://github.com/sanzhardanybayev/synergy 2>/dev/null \
    | sed -n 's#.*refs/tags/v\([0-9.]*\)$#\1#p' | sort -V | tail -1)"
  if [ -n "$upstream" ] && [ "$upstream" != "$newest" ] && \
     [ "$(printf '%s\n%s\n' "$newest" "$upstream" | sort -V | tail -1)" = "$upstream" ]; then
    printf 'ℹ synergy: v%s is published upstream — run /plugin update to fetch it.\n' "$upstream"
  fi
fi
exit 0
```

Then make it executable:
```bash
chmod +x hooks/session-start.sh
```

- [ ] **Step 4: Register the hook**

`hooks/hooks.json`:
```json
{
  "description": "Synergy freshness guard — warns at session start when a newer plugin version is installed than this session loaded.",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 5: Run test, verify it passes**

Run: `pnpm --filter @synergy/plugin-guard exec vitest run tests/hook.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hooks/hooks.json hooks/session-start.sh packages/plugin-guard/tests/hook.test.ts
git commit -m "feat(hooks): SessionStart freshness warning (pure bash, fails open)"
```

---

### Task 7: Skill Step-0 preflight + version stamps

**Files:**
- Modify: `skills/create-spec/SKILL.md`, `skills/execute/SKILL.md`, `skills/spec-authoring/SKILL.md`, `skills/resume/SKILL.md`

**Interfaces:**
- Consumes: the `<!-- synergy-version: X -->` stamp (maintained by version-sync, Task 3).

- [ ] **Step 1: Add the stamp + Step 0 to each authoring skill**

For EACH of the four files, immediately after the closing frontmatter `---`, insert the stamp line, then add the Step-0 section as the first section of the body. Insert verbatim (the `0.6.0` is a placeholder that Task 8's `version-sync` rewrites to `0.7.0`):

```markdown
<!-- synergy-version: 0.6.0 -->

## Step 0 — Freshness check (run before anything else)

This skill loads at session start, so it can be **stale** if the plugin was
updated mid-session. Before doing any work, confirm you are the newest installed
version. Set `MINE` to the version in the `synergy-version` marker at the top of
this file, then run:

```bash
MINE="0.6.0"  # ← the synergy-version marker above
CACHE="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}/cache/synergy/synergy"
NEWEST="$(ls "$CACHE" 2>/dev/null | sort -V | tail -1)"
if [ -n "$NEWEST" ] && [ "$NEWEST" != "$MINE" ] && \
   [ "$(printf '%s\n%s\n' "$MINE" "$NEWEST" | sort -V | tail -1)" = "$NEWEST" ]; then
  printf '⚠ synergy: this session loaded v%s, but v%s is installed. Restart Claude Code to load the latest skills/templates.\n' "$MINE" "$NEWEST"
fi
```

If it prints a warning, **surface that line to the user verbatim** before
continuing. Then proceed — staleness is a warning, not a block.
```

- [ ] **Step 2: Verify each file has exactly one stamp and a Step 0**

Run:
```bash
for f in create-spec execute spec-authoring resume; do
  echo "== $f =="; grep -c "synergy-version:" "skills/$f/SKILL.md"; grep -c "Step 0 — Freshness check" "skills/$f/SKILL.md"
done
```
Expected: each prints `1` then `1`.

- [ ] **Step 3: Commit**

```bash
git add skills/create-spec/SKILL.md skills/execute/SKILL.md skills/spec-authoring/SKILL.md skills/resume/SKILL.md
git commit -m "feat(skills): Step-0 freshness preflight + version stamp"
```

---

### Task 8: Version bump to 0.7.0 + docs + full verification

**Files:**
- Modify: `.claude-plugin/plugin.json` (→ `0.7.0`)
- Modify (via tool): `.claude-plugin/marketplace.json`, four `SKILL.md` stamps (written by version-sync)
- Modify: `CLAUDE.md` — add a "Release & freshness" subsection

- [ ] **Step 1: Bump the source of truth**

Edit `.claude-plugin/plugin.json`: `"version": "0.6.0"` → `"version": "0.7.0"`.

- [ ] **Step 2: Propagate via version-sync**

Run:
```bash
pnpm exec tsx packages/plugin-guard/src/version-sync.ts
pnpm exec tsx packages/plugin-guard/src/version-sync.ts --check && echo "consistent"
```
Expected: marketplace.json + the four skill stamps now read `0.7.0`; second command prints `consistent` (exit 0).

- [ ] **Step 3: Confirm the Step-0 `MINE` literal updated too**

Run:
```bash
grep -h 'MINE="' skills/*/SKILL.md | sort -u
grep -h 'synergy-version: ' skills/*/SKILL.md | sort -u
```
Expected: both show `0.7.0`. (If the `MINE="0.6.0"` literal did NOT update — version-sync only rewrites the marker comment — fix the four `MINE="..."` lines by hand to `0.7.0` and re-run `--check`. Document this coupling in the commit.)

- [ ] **Step 4: Add docs to CLAUDE.md**

Add a subsection under `## Commands` (or near "What not to do"):
```markdown
## Release & freshness

- `.claude-plugin/plugin.json` `version` is the single source of truth. Never
  hand-edit `marketplace.json` or SKILL.md `synergy-version` stamps — lefthook
  runs `version-sync` on commit to derive them.
- A behavior change under `skills/`, `packages/`, `commands/`, or `hooks/` MUST
  bump the version; CI (`release-gate`) fails the PR otherwise. `examples/` and
  `docs/` are exempt.
- A `SessionStart` hook + a Step-0 check in the authoring skills warn (and
  proceed) when a session is running an older version than is installed.
```

- [ ] **Step 5: Full verification**

Run:
```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm exec tsx packages/plugin-guard/src/version-sync.ts --check && echo "stamps consistent"
```
Expected: all green; `stamps consistent` printed. (If `pnpm lint` flags the bash file, add it to Biome's ignore or accept — Biome does not lint shell; verify no TS/JSON errors.)

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json skills/*/SKILL.md CLAUDE.md
git commit -m "release: 0.7.0 — plugin freshness guard"
```

- [ ] **Step 7: Push + open the PR**

```bash
git push -u origin feat/plugin-freshness-guard
gh pr create --base main --title "Plugin freshness guard" --body "<summary + link to docs/superpowers/specs/2026-06-26-plugin-freshness-guard-design.md>"
```

---

## Self-Review

**Spec coverage:**
- Backbone/source-of-truth + derived stamps → Tasks 3, 4, 8. ✓
- Release gate (lefthook auto-stamp) → Task 4. ✓
- CI bump + consistency gate → Task 5. ✓
- SessionStart hook (local + best-effort upstream) → Task 6. ✓
- Skill Step-0 preflight → Task 7. ✓
- Fail-open, sort -V, downgrade-not-stale → Tasks 1, 6, 7. ✓
- Ships 0.6.0 → 0.7.0 → Task 8. ✓

**Known coupling flagged for the implementer:** the SKILL.md stamp lives in two textual spots — the `<!-- synergy-version: -->` comment AND the `MINE="..."` literal in Step 0. `version-sync` (as specified) rewrites only the comment. Task 8 Step 3 catches this and either hand-fixes or the implementer should extend `setSkillStamp` to also rewrite `MINE="..."`. Prefer extending `setSkillStamp` with a second replace (`/MINE="[^"]*"/`) so both stay automatic — do this in Task 3 if taken there first.

**Placeholder scan:** PR body has one intentional `<summary…>` placeholder for the author to fill at PR time. No code placeholders.

**Type consistency:** `compareVersions`/`newest`/`isStale` (Task 1), `requiresBump` (Task 2), `setMarketplaceVersion`/`setSkillStamp` (Task 3), `run` (Task 3), `shouldFail` (Task 5) — names used consistently across tasks and tests.
