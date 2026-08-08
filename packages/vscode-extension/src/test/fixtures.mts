import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type ReviewInsights,
  type ReviewProgress,
  type ReviewSnapshot,
  type ReviewSource,
  type ReviewWorkspace,
  applyCodeSections,
  buildDiffSnapshot,
  buildScopeSnapshot,
  createReviewStore,
  reviewsDir,
} from '@synergy/review-core';

/**
 * Builds the on-disk fixture repository the extension-host integration suite opens as its
 * workspace folder.
 *
 * Every artifact goes through review-core's real builders (`buildScopeSnapshot`,
 * `applyCodeSections`, `buildDiffSnapshot`) and the real `createReviewStore.createRevision`,
 * not hand-written JSON. That means review-item ids, content hashes and location hashes are
 * derived exactly the way the review CLI derives them, and the fixture cannot exist at all
 * unless it satisfies every schema and cross-artifact invariant the store enforces - so the
 * suite exercises the extension against genuinely production-shaped data.
 *
 * Runs in plain Node before VS Code launches (see runTests.ts), so it must not import `vscode`.
 * The generated ids are written to `synergy-fixture.json` at the repo root for the suite to read.
 */

export const SCOPE_WORKSPACE_ID = 'ws-scope';
export const SCOPE_REVISION_ID = 'rev-scope-1';
export const DIFF_WORKSPACE_ID = 'ws-diff';
export const DIFF_REVISION_ID = 'rev-diff-1';
export const DEGRADED_WORKSPACE_ID = 'ws-broken';
export const MANIFEST_FILE = 'synergy-fixture.json';

/** Paths, relative to the fixture repo root. */
export const PATHS = {
  /** Scope session, clean on disk (captured lines match the file byte for byte). */
  scopeClean: 'src/alpha.ts',
  /** Scope session, drifted on disk (edited after capture). */
  scopeDrifted: 'src/beta.ts',
  /** Diff session, textual hunk, clean on disk. */
  diffClean: 'src/gamma.ts',
  /** Diff session, textual hunk, drifted on disk. */
  diffDrifted: 'src/epsilon.ts',
  /** Diff session, zero-hunk rename: no textual rows, so no decorations are possible. */
  diffFileOnly: 'src/delta.ts',
} as const;

/**
 * Filler files added to the scope session. They exist so the rendered review pane is reliably
 * TALLER than the webview viewport - without that the scroll-restore regression test (I4) would
 * silently assert against a pane that never scrolls.
 */
export const FILLER_COUNT = 40;
export const fillerPath = (index: number): string =>
  `src/filler/module-${String(index).padStart(2, '0')}.ts`;

/** What `seedFixtureRepo` writes to `synergy-fixture.json`; read back by the suite. */
export interface FixtureManifest {
  root: string;
  scope: { workspaceId: string; revisionId: string; itemIdsByPath: Record<string, string[]> };
  diff: { workspaceId: string; revisionId: string; itemIdsByPath: Record<string, string[]> };
  degradedWorkspaceId: string;
}

const ALPHA_SOURCE = [
  'export interface AlphaOptions {',
  '  readonly label: string;',
  '}',
  '',
  'export function alpha(options: AlphaOptions): string {',
  '  return options.label.toUpperCase();',
  '}',
].join('\n');

const BETA_CAPTURED = [
  'export const beta = 1;',
  'export const betaName = "captured";',
  'export const betaExtra = true;',
].join('\n');

const BETA_ON_DISK = [
  'export const beta = 99;',
  'export const betaName = "edited-after-capture";',
  'export const betaExtra = true;',
].join('\n');

const GAMMA_ON_DISK = [
  'export const gammaHeader = 0;',
  '',
  'export const gamma = 2;',
  '',
  'export const gammaTail = 3;',
].join('\n');

/** Diverges from what the patch captured at line 3, so this file reads as `drifted`. */
const EPSILON_ON_DISK = [
  'export const epsilonHeader = 0;',
  '',
  'export const epsilon = 777;',
  '',
  'export const epsilonTail = 3;',
].join('\n');

const DELTA_ON_DISK = 'export const delta = "renamed file";';

const PATCH = [
  `diff --git a/${PATHS.diffClean} b/${PATHS.diffClean}`,
  'index 1111111..2222222 100644',
  `--- a/${PATHS.diffClean}`,
  `+++ b/${PATHS.diffClean}`,
  '@@ -3 +3 @@',
  '-export const gamma = 1;',
  '+export const gamma = 2;',
  `diff --git a/${PATHS.diffDrifted} b/${PATHS.diffDrifted}`,
  'index 3333333..4444444 100644',
  `--- a/${PATHS.diffDrifted}`,
  `+++ b/${PATHS.diffDrifted}`,
  // Two hunks in one file, so `setStatusBatch` (the file-level check-all) genuinely covers more
  // than one review item.
  '@@ -3 +3 @@',
  '-export const epsilon = 1;',
  '+export const epsilon = 2;',
  '@@ -5 +5 @@',
  '-export const epsilonTail = 2;',
  '+export const epsilonTail = 3;',
  'diff --git a/src/delta-old.ts b/src/delta.ts',
  'similarity index 100%',
  'rename from src/delta-old.ts',
  'rename to src/delta.ts',
  '',
].join('\n');

function writeSource(root: string, path: string, text: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${text}\n`, 'utf8');
}

/**
 * Captured lines for a file whose on-disk form is `${text}\n` (what `writeSource` writes). The
 * trailing newline yields a final empty line record, which is exactly what a real capture stores
 * and what `fileDrift` needs in order to reconstruct the file byte for byte and report 'clean'.
 */
function capturedLines(text: string): { number: number; text: string }[] {
  return `${text}\n`.split('\n').map((line, index) => ({ number: index + 1, text: line }));
}

function itemIdsByPath(snapshot: ReviewSnapshot): Record<string, string[]> {
  const byPath: Record<string, string[]> = {};
  for (const item of snapshot.items) {
    const existing = byPath[item.path] ?? [];
    existing.push(item.id);
    byPath[item.path] = existing;
  }
  return byPath;
}

function pendingProgress(snapshot: ReviewSnapshot, updatedAt: string): ReviewProgress {
  const items: ReviewProgress['items'] = {};
  for (const item of snapshot.items) items[item.id] = { status: 'needs-review' };
  return { schemaVersion: 1, updatedAt, items };
}

function workspaceFor(
  id: string,
  source: ReviewSource,
  revisionId: string,
  timestamp: string,
): ReviewWorkspace {
  return {
    schemaVersion: 1,
    id,
    repository: { root: '/fixture/repo', name: 'fixture-repo' },
    source,
    currentRevisionId: revisionId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function fillerFiles(): { index: number; path: string; text: string }[] {
  return Array.from({ length: FILLER_COUNT }, (_unused, index) => ({
    index,
    path: fillerPath(index),
    text: [`export const filler${index} = ${index};`, `export type Filler${index} = number;`].join(
      '\n',
    ),
  }));
}

function seedScopeSession(root: string): ReviewSnapshot {
  const source: ReviewSource = { kind: 'scope', patterns: ['src/**'], headSha: 'sha-scope' };
  const createdAt = '2026-02-01T00:00:00.000Z';
  const base = buildScopeSnapshot({
    revisionId: SCOPE_REVISION_ID,
    source,
    fingerprint: 'fingerprint-scope',
    createdAt,
    files: [
      { path: PATHS.scopeClean, binary: false, lines: capturedLines(ALPHA_SOURCE) },
      { path: PATHS.scopeDrifted, binary: false, lines: capturedLines(BETA_CAPTURED) },
      ...fillerFiles().map((filler) => ({
        path: filler.path,
        binary: false,
        lines: capturedLines(filler.text),
      })),
    ],
  });
  const snapshot = applyCodeSections(base, [
    { path: PATHS.scopeClean, label: 'AlphaOptions', start: 1, end: 3 },
    { path: PATHS.scopeClean, label: 'alpha()', start: 5, end: 7 },
    { path: PATHS.scopeDrifted, label: 'beta constants', start: 1, end: 3 },
    ...fillerFiles().map((filler) => ({
      path: filler.path,
      label: `filler ${filler.index}`,
      start: 1,
      end: 2,
    })),
  ]);
  const insights: ReviewInsights = {
    schemaVersion: 1,
    revisionId: SCOPE_REVISION_ID,
    groups: [
      {
        id: 'group-scope',
        label: 'Scoped source',
        reviewItemIds: snapshot.items.map((item) => item.id),
      },
    ],
    items: snapshot.items.map((item) => ({
      reviewItemId: item.id,
      description: `Reviewed section: ${item.label}.`,
      confidence: 'high' as const,
      evidencePaths: [item.path],
    })),
    files: [
      {
        path: PATHS.scopeClean,
        description: 'Alpha module: pure string helper plus its options type.',
        confidence: 'high',
      },
      {
        path: PATHS.scopeDrifted,
        description: 'Beta module: constant exports captured before the local edit.',
        confidence: 'medium',
      },
    ],
  };
  createReviewStore(root).createRevision(
    workspaceFor(SCOPE_WORKSPACE_ID, source, SCOPE_REVISION_ID, createdAt),
    snapshot,
    insights,
    pendingProgress(snapshot, createdAt),
  );
  return snapshot;
}

function seedDiffSession(root: string): ReviewSnapshot {
  const source: ReviewSource = {
    kind: 'pr',
    number: 4242,
    url: 'https://example.invalid/pr/4242',
    baseSha: 'sha-base',
    headSha: 'sha-head',
  };
  const createdAt = '2026-03-01T00:00:00.000Z';
  const snapshot = buildDiffSnapshot({
    revisionId: DIFF_REVISION_ID,
    source,
    fingerprint: 'fingerprint-diff',
    createdAt,
    patch: PATCH,
  });
  const insights: ReviewInsights = {
    schemaVersion: 1,
    revisionId: DIFF_REVISION_ID,
    groups: [
      {
        id: 'group-diff',
        label: 'Changed files',
        reviewItemIds: snapshot.items.map((item) => item.id),
      },
    ],
    items: snapshot.items.map((item) => ({
      reviewItemId: item.id,
      description: `Change in ${item.path}: ${item.label}.`,
      confidence: 'medium' as const,
      evidencePaths: [item.path],
    })),
    files: [
      {
        path: PATHS.diffClean,
        description: 'Gamma module: single constant bumped from 1 to 2.',
        confidence: 'high',
      },
      {
        path: PATHS.diffDrifted,
        description: 'Epsilon module: constant change, edited again since capture.',
        confidence: 'medium',
      },
      { path: PATHS.diffFileOnly, description: 'Delta module: pure rename.', confidence: 'low' },
    ],
  };
  createReviewStore(root).createRevision(
    workspaceFor(DIFF_WORKSPACE_ID, source, DIFF_REVISION_ID, createdAt),
    snapshot,
    insights,
    pendingProgress(snapshot, createdAt),
  );
  return snapshot;
}

/**
 * Writes a workspace directory whose `workspace.json` is unparseable. `listSessions` must still
 * list the two healthy sessions and surface this one as `degraded` rather than throwing.
 */
function seedDegradedWorkspace(root: string): void {
  const dir = join(reviewsDir(root), DEGRADED_WORKSPACE_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workspace.json'), '{ this is not json', 'utf8');
}

/** Creates the fixture repository at `root`, writes the manifest, and returns it. */
export function seedFixtureRepo(root: string): FixtureManifest {
  writeSource(root, PATHS.scopeClean, ALPHA_SOURCE);
  writeSource(root, PATHS.scopeDrifted, BETA_ON_DISK);
  writeSource(root, PATHS.diffClean, GAMMA_ON_DISK);
  writeSource(root, PATHS.diffDrifted, EPSILON_ON_DISK);
  writeSource(root, PATHS.diffFileOnly, DELTA_ON_DISK);
  for (const filler of fillerFiles()) writeSource(root, filler.path, filler.text);
  // A tsconfig makes VS Code's bundled TypeScript service treat the fixture as a real project,
  // which is what the document-symbol assertion (real language services on the opened buffer)
  // depends on.
  writeFileSync(
    join(root, 'tsconfig.json'),
    `${JSON.stringify(
      { compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true }, include: ['src'] },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const scopeSnapshot = seedScopeSession(root);
  const diffSnapshot = seedDiffSession(root);
  seedDegradedWorkspace(root);

  const manifest: FixtureManifest = {
    root,
    scope: {
      workspaceId: SCOPE_WORKSPACE_ID,
      revisionId: SCOPE_REVISION_ID,
      itemIdsByPath: itemIdsByPath(scopeSnapshot),
    },
    diff: {
      workspaceId: DIFF_WORKSPACE_ID,
      revisionId: DIFF_REVISION_ID,
      itemIdsByPath: itemIdsByPath(diffSnapshot),
    },
    degradedWorkspaceId: DEGRADED_WORKSPACE_ID,
  };
  writeFileSync(join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}
