import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ReviewBundle, createReviewStore } from '@synergy/review-core';
import * as vscode from 'vscode';
import type { FixtureManifest } from '../fixtures.mjs';
import { FILLER_COUNT, PATHS } from '../fixtures.mjs';
import { type WebviewHarness, createWebviewHarness } from './webview-harness.js';

/**
 * Extension-host integration suite: everything here runs inside a real VS Code instance with the
 * packaged extension loaded from disk, against the fixture repository seeded by runTests.ts.
 *
 * These are the paths the vitest unit suites cannot reach at all - real activation, a real
 * webview under a real CSP, real editor/tab/language-service state, and real writes landing in
 * `.synergy/reviews/**\/progress.json`.
 */

const EXTENSION_ID = 'synergy.synergy-vscode';
const SNAPSHOT_SCHEME = 'synergy-review-snapshot';
const BASE_SCHEME = 'synergy-review-base';

interface ToWebviewMessage {
  kind: string;
  [key: string]: unknown;
}

/** Mirrors `SynergyReviewApi` in src/extension.ts without importing the extension bundle. */
interface ExtensionApi {
  provider: vscode.WebviewViewProvider & {
    onDidPostMessage(listener: (message: ToWebviewMessage) => void): { dispose(): void };
    refresh(): void;
  };
  mediaRoot: vscode.Uri;
}

function loadManifest(): FixtureManifest {
  const path = process.env.SYNERGY_FIXTURE_MANIFEST;
  if (!path) throw new Error('SYNERGY_FIXTURE_MANIFEST is not set; runTests.ts must provide it');
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureManifest;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it returns a value, or fails the test with `label` after `timeoutMs`. */
async function waitFor<T>(
  label: string,
  check: () => T | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(50);
  }
}

function snapshotUriFor(workspaceId: string, revisionId: string, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SNAPSHOT_SCHEME,
    path: `/${path}`,
    query: `workspaceId=${encodeURIComponent(workspaceId)}&revisionId=${encodeURIComponent(revisionId)}`,
  });
}

describe('Synergy Review extension (extension host)', () => {
  const manifest = loadManifest();
  /** Every message the provider posted for the whole run; used for the "no errors" assertion. */
  const allPosts: ToWebviewMessage[] = [];
  let api: ExtensionApi;
  let postSubscription: { dispose(): void };

  function postsOfKind(kind: string): ToWebviewMessage[] {
    return allPosts.filter((message) => message.kind === kind);
  }

  function readBundle(which: 'scope' | 'diff'): ReviewBundle {
    const target = manifest[which];
    return createReviewStore(manifest.root).readBundle(target.workspaceId, target.revisionId);
  }

  before(async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} is not installed in this host`);
    api = (await extension.activate()) as ExtensionApi;
    postSubscription = api.provider.onDidPostMessage((message) => {
      allPosts.push(message);
    });
  });

  after(() => {
    postSubscription?.dispose();
  });

  // ---- 1 + 2: activation, the real activity-bar view, and the webview round trip ----

  describe('activation and the real activity-bar view', () => {
    it('activates without error and exposes its provider', () => {
      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      assert.equal(extension?.isActive, true);
      assert.ok(api.provider, 'activate() did not return a provider');
      assert.ok(api.mediaRoot.fsPath.endsWith('media'), 'mediaRoot does not point at media/');
    });

    it('resolves its webview when the Synergy Review view container is focused, and the webview boots and round-trips ready -> sessions', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.synergyReview');
      await vscode.commands.executeCommand('synergyReview.panel.focus');

      // Only `panel.js` sending `ready` makes the provider post `sessions`, so receiving one
      // proves the real view resolved, its HTML loaded, and its script executed under the CSP.
      const sessions = await waitFor(
        'the real view to post its session list',
        () => postsOfKind('sessions')[0],
      );
      const rows = sessions.sessions as { workspaceId: string; degraded?: string }[];
      const healthy = rows.filter((row) => !row.degraded);
      const degraded = rows.filter((row) => row.degraded);
      assert.equal(healthy.length, 2, `expected 2 healthy fixture sessions, got ${rows.length}`);
      assert.deepEqual(
        healthy.map((row) => row.workspaceId).sort(),
        [manifest.diff.workspaceId, manifest.scope.workspaceId].sort(),
      );
      assert.equal(degraded.length, 1, 'the corrupt workspace should list as degraded, not throw');
      assert.equal(degraded[0]?.workspaceId, manifest.degradedWorkspaceId);
    });
  });

  // ---- 3-10: flows driven through a real webview running the real panel.js ----

  describe('review flows through a real webview', () => {
    let harness: WebviewHarness;

    before(async function () {
      this.timeout(60_000);
      harness = createWebviewHarness(api.provider, api.mediaRoot);
      await harness.whenReady();
    });

    after(() => {
      harness?.dispose();
    });

    it('renders the session list in the webview (panel.js executed under the CSP)', async () => {
      const result = await pollQuery(harness, '.session-card', 3);
      assert.equal(result.count, 3, 'expected 2 healthy + 1 degraded session card');
      const degradedCards = await harness.query('.session-card-degraded');
      assert.equal(degradedCards.count, 1, 'the corrupt workspace must render non-interactive');
    });

    it('openSession posts a bundle whose drift map covers every path in the snapshot', async () => {
      // Sessions sort newest-first: diff (2026-03-01), scope (2026-02-01), degraded (epoch).
      await harness.click('.session-card', 0);
      const bundleMessage = await waitFor('a bundle post for the diff session', () =>
        postsOfKind('bundle').find(
          (message) =>
            (message.bundle as { bundle: ReviewBundle }).bundle.workspace.id ===
            manifest.diff.workspaceId,
        ),
      );
      const serialized = bundleMessage.bundle as {
        bundle: ReviewBundle;
        drift: Record<string, string>;
        projectRoot: string;
      };
      assert.equal(serialized.projectRoot, manifest.root);
      assert.ok(serialized.bundle.snapshot, 'bundle.snapshot missing');
      assert.ok(serialized.bundle.insights, 'bundle.insights missing');
      assert.ok(serialized.bundle.progress, 'bundle.progress missing');
      assert.equal(serialized.bundle.snapshot.kind, 'diff');

      const snapshotPaths = new Set<string>();
      for (const file of serialized.bundle.snapshot.files) snapshotPaths.add(file.path);
      for (const item of serialized.bundle.snapshot.items) snapshotPaths.add(item.path);
      assert.deepEqual(
        Object.keys(serialized.drift).sort(),
        [...snapshotPaths].sort(),
        'drift map must cover exactly the snapshot paths',
      );
      assert.equal(serialized.drift[PATHS.diffClean], 'clean');
      assert.equal(serialized.drift[PATHS.diffDrifted], 'drifted');

      // And the webview actually rendered it.
      const groups = await pollQuery(harness, '.file-row', 3);
      assert.equal(groups.count, 3, 'expected one file row per changed file');
    });

    it('openHunk opens the right file at the right line, and real language services answer on that buffer', async () => {
      const bundle = readBundle('diff');
      const item = bundle.snapshot.items.find((candidate) => candidate.path === PATHS.diffClean);
      assert.ok(item, 'fixture diff snapshot has no item for the clean file');

      await harness.click('.file-row', 0); // expand src/gamma.ts
      await pollQuery(harness, '.hunk-row', 1);
      await harness.click('.hunk-row', 0);

      const editor = await waitFor('the editor to open the hunk file', () => {
        const active = vscode.window.activeTextEditor;
        return active?.document.uri.fsPath === join(manifest.root, PATHS.diffClean)
          ? active
          : undefined;
      });
      assert.equal(
        editor.selection.active.line,
        item.range.start - 1,
        'selection is not on the hunk start line',
      );

      const resolved = await waitForSymbols(editor.document.uri);
      assert.ok(resolved.length > 0, 'no document symbols returned for the opened TS buffer');
    });

    it('applies hunk decorations without throwing for both a clean and a drifted file', async () => {
      // Decorations cannot be read back through the VS Code API, so this asserts the command path
      // runs to completion (the pure range math is covered by decoration-ranges.test.ts).
      await harness.click('.file-row', 1); // expand src/epsilon.ts (drifted)
      // src/gamma.ts is still expanded from the previous test, so its single hunk row is index 0
      // and epsilon's first hunk row is index 1.
      await pollQuery(harness, '.hunk-row', 3);
      await harness.click('.hunk-row', 1);
      await waitFor('the editor to open the drifted hunk file', () =>
        vscode.window.activeTextEditor?.document.uri.fsPath ===
        join(manifest.root, PATHS.diffDrifted)
          ? true
          : undefined,
      );
      assert.equal(postsOfKind('error').length, 0, 'decoration path posted an error');
    });

    it('setStatus writes progress.json and refreshes the pane once for the write', async () => {
      const bundle = readBundle('diff');
      const item = bundle.snapshot.items.find((candidate) => candidate.path === PATHS.diffClean);
      assert.ok(item);

      const before = postsOfKind('bundle').length;
      await harness.click('.hunk-row input[type="checkbox"]', 0);
      // Messages reach the host in order, so by the time the bridge's click reply lands the
      // provider has already handled `setStatus` and posted its refresh. Count inside a window
      // shorter than the fs-watcher debounce (REFRESH_DEBOUNCE_MS = 250) so the watcher's own,
      // independent refresh of the same write is not counted as a duplicate.
      await delay(120);
      assert.equal(
        postsOfKind('bundle').length - before,
        1,
        'setStatus should refresh the pane exactly once',
      );
      await waitFor('progress.json to record the reviewed status', () => {
        const status = readBundle('diff').progress.items[item.id]?.status;
        return status === 'reviewed' ? status : undefined;
      });
    });

    it('setStatusBatch writes every item in the file with a single refresh', async () => {
      const ids = manifest.diff.itemIdsByPath[PATHS.diffDrifted];
      assert.ok(ids && ids.length > 1, 'fixture needs a multi-item file to make this meaningful');

      const before = postsOfKind('bundle').length;
      await harness.click('.file-row input[type="checkbox"]', 1);
      await delay(120);
      assert.equal(
        postsOfKind('bundle').length - before,
        1,
        `setStatusBatch refreshed more than once for ${ids.length} items`,
      );
      await waitFor('every item in the file to become reviewed', () => {
        const progress = readBundle('diff').progress;
        return ids.every((id) => progress.items[id]?.status === 'reviewed') ? true : undefined;
      });
    });

    it('saveNote persists the note to disk', async () => {
      const bundle = readBundle('diff');
      const item = bundle.snapshot.items.find((candidate) => candidate.path === PATHS.diffClean);
      assert.ok(item);
      const note = 'integration-suite note';

      const result = (await harness.setNote(item.id, note)) as { blurObserved: boolean };
      assert.equal(result.blurObserved, true, "panel.js's blur handler did not run");
      try {
        const persisted = await waitFor('the note to persist', () => {
          const stored = readBundle('diff').progress.items[item.id]?.note;
          return stored === note ? stored : undefined;
        });
        assert.equal(persisted, note);
      } catch (error) {
        // Surface what the webview actually sent - a missing `saveNote` is a very different
        // failure from a write that did not land.
        assert.fail(`${String(error)}; webview -> host sent: ${sentKinds(harness)}`);
      }
    });

    it('opens a captured-snapshot document with the hunks-only banner for a diff session', async () => {
      const uri = snapshotUriFor(
        manifest.diff.workspaceId,
        manifest.diff.revisionId,
        PATHS.diffDrifted,
      );
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      assert.match(text, /captured hunks only - not a full-file reconstruction/);
      assert.match(text, /export const epsilon = 2;/);
      assert.doesNotMatch(text, /full file as captured/);
    });

    it('renders inline hunk diff bodies, removed lines included, for expanded files', async () => {
      const bodies = await pollQuery(harness, '.hunk-diff', 1);
      assert.ok(bodies.count >= 1, 'expected at least one inline hunk diff body');
      const removed = await harness.query('.hunk-diff .diff-line-remove');
      assert.ok(removed.count >= 1, 'expected removed lines to be visible in the inline diff');
    });

    it('syntax-highlights the inline hunk bodies under the CSP', async () => {
      // `.diff-marker` only exists once paintTokens() has replaced the plain line, and a token's
      // color is written through CSSOM - the CSP blocks inline style ATTRIBUTES, so this asserts
      // the highlighter both ran and was allowed to color what it produced.
      const markers = await pollQuery(harness, '.hunk-diff .diff-marker', 1);
      assert.ok(markers.count >= 1, 'expected highlighted lines in the inline diff');
      const colored = await harness.query('.hunk-diff .diff-text span[style*="color"]');
      assert.ok(colored.count >= 1, 'expected at least one colored syntax token');
    });

    it('the diff toggle hides inline hunk bodies and comes back on', async () => {
      await harness.click('.diff-toggle', 0);
      await pollQuery(harness, '.hunk-diff', 0);
      const hidden = await harness.query('.hunk-diff');
      assert.equal(hidden.count, 0, 'diff bodies must disappear when the toggle is off');
      await harness.click('.diff-toggle', 0);
      const shown = await pollQuery(harness, '.hunk-diff', 1);
      assert.ok(shown.count >= 1, 'diff bodies must return when the toggle is back on');
    });

    it('vscode.diff opens a native diff tab against the reconstructed base for a drifted file', async () => {
      // Both src/gamma.ts (index 0) and src/epsilon.ts (index 1, drifted) are expanded; every
      // expanded file now renders an "Open diff" action, and the drifted one adds
      // "Show captured snapshot". Button index 1 is epsilon's "Open diff".
      await harness.click('.file-actions button', 1);
      const tab = await waitFor('a Synergy diff tab', () => {
        for (const group of vscode.window.tabGroups.all) {
          for (const candidate of group.tabs) {
            if (
              candidate.input instanceof vscode.TabInputTextDiff &&
              candidate.label.startsWith('Synergy: ')
            ) {
              return candidate;
            }
          }
        }
        return undefined;
      });
      assert.match(tab.label, /^Synergy: .*\(base vs current\)$/);
      const input = tab.input as vscode.TabInputTextDiff;
      assert.equal(input.original.scheme, BASE_SCHEME);
      assert.equal(input.modified.fsPath, join(manifest.root, PATHS.diffDrifted));
    });

    it('shows the full-file banner for a scope session snapshot', async () => {
      await harness.click('.icon-button', 0); // "< Back"
      await pollQuery(harness, '.session-card', 3);
      await harness.click('.session-card', 1); // the scope session
      await waitFor('a bundle post for the scope session', () =>
        postsOfKind('bundle').find(
          (message) =>
            (message.bundle as { bundle: ReviewBundle }).bundle.workspace.id ===
            manifest.scope.workspaceId,
        ),
      );

      const uri = snapshotUriFor(
        manifest.scope.workspaceId,
        manifest.scope.revisionId,
        PATHS.scopeDrifted,
      );
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      assert.match(text, /full file as captured/);
      assert.match(text, /export const beta = 1;/, 'should show CAPTURED text, not the disk text');
      assert.doesNotMatch(text, /edited-after-capture/);
    });

    it('reports scope drift correctly (clean file clean, edited file drifted)', async () => {
      const bundleMessage = await waitFor('the scope bundle post', () =>
        postsOfKind('bundle')
          .reverse()
          .find(
            (message) =>
              (message.bundle as { bundle: ReviewBundle }).bundle.workspace.id ===
              manifest.scope.workspaceId,
          ),
      );
      const drift = (bundleMessage.bundle as { drift: Record<string, string> }).drift;
      assert.equal(drift[PATHS.scopeClean], 'clean');
      assert.equal(drift[PATHS.scopeDrifted], 'drifted');
    });

    it('keeps the scroll position across a refresh while a note is focused (regression: I4)', async () => {
      // Runs on the scope session because its FILLER_COUNT filler files guarantee the rendered
      // pane is taller than the webview viewport - otherwise this assertion would be vacuous.
      await pollQuery(harness, '.file-row', FILLER_COUNT);

      // Expand the FIRST file so a note textarea exists near the very top of the pane, focus it,
      // then scroll far away from it. `render()` restores focus by calling `focus()`, which the
      // browser answers by scrolling that element back into view - so a refresh in this state is
      // exactly the case where a scroll restore that targets the wrong element (the pre-fix
      // `app.scrollTop`, which is never the scroll container) fails to undo the jump.
      await harness.click('.file-row', 0);
      const noteIds = manifest.scope.itemIdsByPath[PATHS.scopeClean];
      assert.ok(noteIds?.[0], 'fixture has no scope items for the clean file');
      await pollQuery(harness, '.hunk-note', 1);
      assert.equal(
        await harness.focusNote(noteIds[0]),
        true,
        'the note textarea did not take focus',
      );

      const applied = await harness.scrollTo(400);
      assert.notEqual(
        applied,
        0,
        'the webview did not scroll at all, so scroll restore cannot be verified here',
      );

      const before = postsOfKind('bundle').length;
      api.provider.refresh();
      await waitFor('the refresh to re-render the pane', () =>
        postsOfKind('bundle').length > before ? true : undefined,
      );
      await delay(300);
      const after = await harness.scrollTop();
      assert.equal(after, applied, 'the refresh reset the scroll position');
    });

    it('never posted an error, and never showed one, with no daemon running', () => {
      const errors = postsOfKind('error');
      assert.deepEqual(
        errors.map((message) => message.message),
        [],
        'the happy-path flows must be silent when no Synergy daemon is running',
      );
    });
  });
});

/** Summary of every message the webview posted back to the host, for failure diagnostics. */
function sentKinds(harness: WebviewHarness): string {
  const kinds = harness.received.map((message) =>
    typeof message === 'object' && message !== null
      ? String((message as { kind?: unknown }).kind)
      : String(message),
  );
  return kinds.join(', ') || '(nothing)';
}

/** Polls the webview DOM until at least `minCount` elements match, then returns the last result. */
async function pollQuery(
  harness: WebviewHarness,
  selector: string,
  minCount: number,
): Promise<{ count: number; text: string | null }> {
  const deadline = Date.now() + 20_000;
  let last = await harness.query(selector);
  while (last.count < minCount) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${minCount}x '${selector}' (saw ${last.count})`);
    }
    await delay(100);
    last = await harness.query(selector);
  }
  return last;
}

/**
 * The TypeScript language service starts asynchronously, so the first document-symbol request on
 * a freshly-opened buffer often returns an empty array. Retry until it answers or we give up.
 */
async function waitForSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );
    if (symbols && symbols.length > 0) return symbols;
    if (Date.now() > deadline) return symbols ?? [];
    await delay(500);
  }
}
