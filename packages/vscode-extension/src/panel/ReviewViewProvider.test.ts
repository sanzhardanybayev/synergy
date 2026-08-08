import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ReviewInsights,
  type ReviewProgress,
  type ReviewSnapshot,
  type ReviewSource,
  type ReviewWorkspace,
  createReviewStore,
  hashText,
} from '@synergy/review-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Host } from '../host.js';
import type { ToWebview } from './messages.js';

// `renderWebviewHtml` (src/panel/webview-html.ts) does a genuine *value* import of `vscode`
// (it calls `vscode.Uri.joinPath`), which does not exist as a real module outside an extension
// host. Stub it so importing ReviewViewProvider.ts - which imports webview-html.ts - never
// touches the real module. ReviewViewProvider.ts's own `import type * as vscode from 'vscode'`
// is type-only and erased at build time, so nothing else here needs a `vscode` stub.
vi.mock('./webview-html.js', () => ({
  renderWebviewHtml: () => '<html><body><div id="app"></div></body></html>',
}));

// `../editor/native-diff.js` and `../editor/snapshot-provider.js` are likewise real `vscode`
// value-importers (native-diff.ts imports snapshot-provider.ts too), pulled in transitively by
// ReviewViewProvider.ts. None of the scenarios this suite covers exercise `openNativeDiff` /
// `showSnapshot`, so trivial stubs are enough to keep the module graph `vscode`-free.
vi.mock('../editor/native-diff.js', () => ({
  openNativeDiff: async () => {},
}));
vi.mock('../editor/snapshot-provider.js', () => ({
  openSnapshotDocument: async () => {},
  parseSnapshotUri: (uri: unknown) => uri,
  snapshotUri: (_ref: unknown, path: string) => `synergy-review-snapshot:${path}`,
}));
// `../editor/base-provider.js` is a `vscode` value-importer too (base URIs for native diffs).
// This suite never resolves base content through a real URI, so a pass-through stub suffices.
vi.mock('../editor/base-provider.js', () => ({
  parseBaseUri: (uri: unknown) => uri,
  baseUri: (_ref: unknown, path: string) => `synergy-review-base:${path}`,
}));

// `daemon.ts`'s `tryConnectDaemon` opens a real HTTP connection to whatever the project's
// `.synergy/preview.runtime.json` (or the default :4321) resolves to. Stubbing it keeps this
// suite hermetic (no dependency on a preview server actually running) and lets tests assert on
// connect/dispose calls precisely instead of racing a real socket.
const daemonConnectCalls: Array<{ projectRoot: string; workspaceId: string; revisionId: string }> =
  [];
const daemonDisposeIds: string[] = [];
vi.mock('../data/daemon.js', () => ({
  tryConnectDaemon: (
    projectRoot: string,
    reference: { workspaceId: string; revisionId: string },
  ) => {
    const id = `${projectRoot}:${reference.workspaceId}:${reference.revisionId}`;
    daemonConnectCalls.push({
      projectRoot,
      workspaceId: reference.workspaceId,
      revisionId: reference.revisionId,
    });
    return { dispose: () => daemonDisposeIds.push(id) };
  },
}));

const { ReviewViewProvider } = await import('./ReviewViewProvider.js');

interface Fixture {
  workspace: ReviewWorkspace;
  snapshot: ReviewSnapshot;
  insights: ReviewInsights;
  progress: ReviewProgress;
}

function makeFixture(options: {
  workspaceId: string;
  revisionId: string;
  source: ReviewSource;
  updatedAt: string;
}): Fixture {
  const { workspaceId, revisionId, source, updatedAt } = options;
  const workspace: ReviewWorkspace = {
    schemaVersion: 1,
    id: workspaceId,
    repository: { root: '/workspace/example', name: 'example' },
    source,
    currentRevisionId: revisionId,
    createdAt: updatedAt,
    updatedAt,
  };
  const snapshot: ReviewSnapshot = {
    schemaVersion: 1,
    revisionId,
    source,
    fingerprint: `fingerprint-${revisionId}`,
    createdAt: updatedAt,
    kind: 'scope',
    files: [
      {
        path: 'src/example.ts',
        binary: false,
        lines: [
          { number: 1, text: 'export const example = true;' },
          { number: 2, text: 'export const other = false;' },
        ],
      },
    ],
    items: [
      {
        id: 'item-1',
        kind: 'code-section',
        path: 'src/example.ts',
        label: 'src/example.ts:1',
        range: { start: 1, end: 1 },
        contentHash: hashText('export const example = true;'),
        locationHash: 'location-hash-1',
      },
      {
        id: 'item-2',
        kind: 'code-section',
        path: 'src/example.ts',
        label: 'src/example.ts:2',
        range: { start: 2, end: 2 },
        contentHash: hashText('export const other = false;'),
        locationHash: 'location-hash-2',
      },
    ],
  };
  const insights: ReviewInsights = {
    schemaVersion: 1,
    revisionId,
    groups: [{ id: 'group-source', label: 'Source', reviewItemIds: ['item-1', 'item-2'] }],
    items: [
      {
        reviewItemId: 'item-1',
        description: 'Example item 1.',
        confidence: 'high',
        evidencePaths: ['src/example.ts'],
      },
      {
        reviewItemId: 'item-2',
        description: 'Example item 2.',
        confidence: 'high',
        evidencePaths: ['src/example.ts'],
      },
    ],
  };
  const progress: ReviewProgress = {
    schemaVersion: 1,
    updatedAt,
    items: {
      'item-1': { status: 'needs-review' },
      'item-2': { status: 'needs-review' },
    },
  };
  return { workspace, snapshot, insights, progress };
}

function createFixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), 'synergy-vscode-provider-'));
}

function seedWorkspace(root: string, fixture: Fixture): void {
  createReviewStore(root).createRevision(
    fixture.workspace,
    fixture.snapshot,
    fixture.insights,
    fixture.progress,
  );
}

/** Minimal stub of the `Host` seam (see src/host.ts) - no `vscode` involved. */
function makeStubHost(projectRoot: string): Host & {
  errors: string[];
  openFileAtCalls: Array<{ absPath: string; startLine: number; endLine: number }>;
  watchDisposeCalls: number;
} {
  const errors: string[] = [];
  const openFileAtCalls: Array<{ absPath: string; startLine: number; endLine: number }> = [];
  const state = { watchDisposeCalls: 0 };
  return {
    workspaceFolders: () => [projectRoot],
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    watch: () => ({
      dispose: () => {
        state.watchDisposeCalls += 1;
      },
    }),
    openFileAt: async (absPath, startLine, endLine) => {
      openFileAtCalls.push({ absPath, startLine, endLine });
    },
    openFile: async () => {},
    applyDecorations: () => {},
    clearDecorations: () => {},
    showError: (message: string) => {
      errors.push(message);
    },
    errors,
    openFileAtCalls,
    get watchDisposeCalls() {
      return state.watchDisposeCalls;
    },
  };
}

/** Fakes just enough of `vscode.WebviewView` for `resolveWebviewView` + message injection. */
function makeFakeWebviewView() {
  let handler: ((raw: unknown) => void) | undefined;
  const posted: ToWebview[] = [];
  const view = {
    webview: {
      options: undefined as unknown,
      html: '',
      cspSource: 'vscode-webview://stub',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: (message: ToWebview) => {
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (cb: (raw: unknown) => void) => {
        handler = cb;
        return {
          dispose: () => {
            if (handler === cb) handler = undefined;
          },
        };
      },
    },
    onDidDispose: () => ({ dispose() {} }),
  };
  return {
    view,
    posted,
    /** Injects a raw postMessage payload as if it came from the webview's JS. */
    send: (raw: unknown) => handler?.(raw),
    hasHandler: () => handler !== undefined,
  };
}

function lastOfKind<K extends ToWebview['kind']>(
  posted: ToWebview[],
  kind: K,
): Extract<ToWebview, { kind: K }> | undefined {
  for (let i = posted.length - 1; i >= 0; i -= 1) {
    const message = posted[i];
    if (message?.kind === kind) return message as Extract<ToWebview, { kind: K }>;
  }
  return undefined;
}

function countOfKind(posted: ToWebview[], kind: ToWebview['kind']): number {
  return posted.filter((message) => message.kind === kind).length;
}

describe('ReviewViewProvider', () => {
  let root: string;
  let host: ReturnType<typeof makeStubHost>;
  let provider: InstanceType<typeof ReviewViewProvider>;
  let webview: ReturnType<typeof makeFakeWebviewView>;
  let ref: { workspaceId: string; revisionId: string };

  beforeEach(() => {
    daemonConnectCalls.length = 0;
    daemonDisposeIds.length = 0;
    root = createFixtureRoot();
    const fixture = makeFixture({
      workspaceId: 'workspace-a',
      revisionId: 'rev-1',
      source: { kind: 'staged', headSha: 'a' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    seedWorkspace(root, fixture);
    ref = { workspaceId: fixture.workspace.id, revisionId: fixture.snapshot.revisionId };

    host = makeStubHost(root);
    // mediaRoot is a `vscode.Uri` never dereferenced because `renderWebviewHtml` is stubbed above.
    provider = new ReviewViewProvider(host, {} as unknown as vscode.Uri);
    webview = makeFakeWebviewView();
    // The fake satisfies the subset of `vscode.WebviewView` the provider actually touches; see
    // makeFakeWebviewView.
    provider.resolveWebviewView(webview.view as unknown as vscode.WebviewView);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('ready posts the session list and disposes any prior daemon link', () => {
    webview.send({ kind: 'openSession', workspaceId: ref.workspaceId, revisionId: ref.revisionId });
    expect(daemonConnectCalls).toHaveLength(1);
    expect(daemonDisposeIds).toHaveLength(0);

    webview.send({ kind: 'ready' });

    expect(daemonDisposeIds).toHaveLength(1);
    const sessions = lastOfKind(webview.posted, 'sessions');
    expect(sessions?.sessions).toHaveLength(1);
    expect(sessions?.sessions[0]?.workspaceId).toBe('workspace-a');
  });

  it('openSession happy path posts the bundle and connects the daemon link', () => {
    webview.send({ kind: 'ready' });

    webview.send({ kind: 'openSession', workspaceId: ref.workspaceId, revisionId: ref.revisionId });

    const bundle = lastOfKind(webview.posted, 'bundle');
    expect(bundle?.bundle.bundle.workspace.id).toBe('workspace-a');
    expect(bundle?.bundle.projectRoot).toBe(root);
    expect(daemonConnectCalls).toEqual([
      { projectRoot: root, workspaceId: ref.workspaceId, revisionId: ref.revisionId },
    ]);
  });

  it('openSession for an unknown session posts an error and does not connect the daemon', () => {
    webview.send({ kind: 'ready' });

    webview.send({ kind: 'openSession', workspaceId: 'no-such-workspace', revisionId: 'rev-1' });

    expect(lastOfKind(webview.posted, 'error')?.message).toMatch(/Session not found/);
    expect(daemonConnectCalls).toHaveLength(0);
  });

  it('openSession for a degraded session posts an error and leaves the screen on sessions', () => {
    // Corrupt the workspace so listSessions() returns it with a `degraded` reason (mirrors
    // sessions.test.ts's "corrupt workspace.json" fixture).
    const fixture = makeFixture({
      workspaceId: 'workspace-bad',
      revisionId: 'rev-1',
      source: { kind: 'staged', headSha: 'a' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    seedWorkspace(root, fixture);
    writeFileSync(
      join(root, '.synergy', 'reviews', 'workspace-bad', 'workspace.json'),
      '{ not valid json',
    );
    webview.send({ kind: 'ready' });

    // listSessions() marks a degraded workspace with revisionId: '' (see src/data/sessions.ts).
    webview.send({ kind: 'openSession', workspaceId: 'workspace-bad', revisionId: '' });

    expect(lastOfKind(webview.posted, 'error')?.message).toMatch(/unavailable/);
    expect(daemonConnectCalls).toHaveLength(0);
    // The screen must still be 'sessions', not a half-applied 'bundle' - proven by `setStatus`
    // (which requires an active bundle screen) failing with "No active session" rather than
    // silently operating against nothing.
    webview.send({ kind: 'setStatus', reviewItemId: 'item-1', status: 'reviewed' });
    expect(lastOfKind(webview.posted, 'error')?.message).toBe('No active session');
  });

  it('setStatus updates the data layer and triggers exactly one refresh', () => {
    webview.send({ kind: 'ready' });
    webview.send({ kind: 'openSession', workspaceId: ref.workspaceId, revisionId: ref.revisionId });
    const bundlePostsBefore = countOfKind(webview.posted, 'bundle');

    webview.send({ kind: 'setStatus', reviewItemId: 'item-1', status: 'reviewed' });

    expect(countOfKind(webview.posted, 'bundle')).toBe(bundlePostsBefore + 1);
    const bundle = lastOfKind(webview.posted, 'bundle');
    expect(bundle?.bundle.bundle.progress.items['item-1']?.status).toBe('reviewed');
    expect(bundle?.bundle.bundle.progress.items['item-2']?.status).toBe('needs-review');
  });

  it('setStatusBatch updates every item and triggers exactly one refresh', () => {
    webview.send({ kind: 'ready' });
    webview.send({ kind: 'openSession', workspaceId: ref.workspaceId, revisionId: ref.revisionId });
    const bundlePostsBefore = countOfKind(webview.posted, 'bundle');

    webview.send({
      kind: 'setStatusBatch',
      reviewItemIds: ['item-1', 'item-2'],
      status: 'reviewed',
    });

    expect(countOfKind(webview.posted, 'bundle')).toBe(bundlePostsBefore + 1);
    const bundle = lastOfKind(webview.posted, 'bundle');
    expect(bundle?.bundle.bundle.progress.items['item-1']?.status).toBe('reviewed');
    expect(bundle?.bundle.bundle.progress.items['item-2']?.status).toBe('reviewed');
  });

  it('saveNote persists the note and refreshes the bundle', () => {
    webview.send({ kind: 'ready' });
    webview.send({ kind: 'openSession', workspaceId: ref.workspaceId, revisionId: ref.revisionId });

    webview.send({ kind: 'saveNote', reviewItemId: 'item-1', note: 'Check the edge case.' });

    const bundle = lastOfKind(webview.posted, 'bundle');
    expect(bundle?.bundle.bundle.progress.items['item-1']?.note).toBe('Check the edge case.');
  });

  it('backToSessions disposes the daemon link and returns to the session list', () => {
    webview.send({ kind: 'ready' });
    webview.send({ kind: 'openSession', workspaceId: ref.workspaceId, revisionId: ref.revisionId });
    expect(daemonConnectCalls).toHaveLength(1);

    webview.send({ kind: 'backToSessions' });

    expect(daemonDisposeIds).toHaveLength(1);
    expect(lastOfKind(webview.posted, 'sessions')).toBeDefined();
  });

  it('a thrown handler exception is caught and posted as an error, not a crash', () => {
    // No session has been opened, so `setStatus` hits `withActiveRef`'s synchronous throw.
    expect(() =>
      webview.send({ kind: 'setStatus', reviewItemId: 'item-1', status: 'reviewed' }),
    ).not.toThrow();

    expect(lastOfKind(webview.posted, 'error')?.message).toBe('No active session');
  });

  it('resolveWebviewView replaces the previous message handler instead of stacking a new one', () => {
    const secondWebview = makeFakeWebviewView();
    provider.resolveWebviewView(secondWebview.view as unknown as vscode.WebviewView);

    // The first fake's handler reference is gone (disposed by the re-resolve); sending through
    // it must not throw or double-deliver.
    expect(webview.hasHandler()).toBe(false);
    secondWebview.send({ kind: 'ready' });
    expect(lastOfKind(secondWebview.posted, 'sessions')).toBeDefined();
  });
});
