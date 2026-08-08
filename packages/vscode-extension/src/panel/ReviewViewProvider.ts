import { join } from 'node:path';
import type { ReviewBundle, ReviewItem, ReviewRef } from '@synergy/review-core';
import type * as vscode from 'vscode';
import { type DaemonLink, tryConnectDaemon } from '../data/daemon.js';
import {
  type SessionSummary,
  listSessions,
  loadBundle,
  saveNote,
  setItemStatus,
} from '../data/sessions.js';
import { resolveBaseContentFromProject } from '../editor/base-content.js';
import { parseBaseUri } from '../editor/base-provider.js';
import { fileDecorationRanges, hunkDecorationRanges } from '../editor/decoration-ranges.js';
import { openNativeDiff } from '../editor/native-diff.js';
import { snapshotContentFor } from '../editor/snapshot-content.js';
import {
  openSnapshotDocument,
  parseSnapshotUri,
  snapshotUri,
} from '../editor/snapshot-provider.js';
import type { Host } from '../host.js';
import { parseFromWebview } from './messages.js';
import type { ToWebview } from './messages.js';
import { serializeBundle } from './serialize.js';
import { renderWebviewHtml } from './webview-html.js';

const REFRESH_DEBOUNCE_MS = 250;

type Screen = { kind: 'sessions' } | { kind: 'bundle'; projectRoot: string; ref: ReviewRef };

/**
 * Backs the `synergyReview.panel` webview view: posts the session list / active bundle to the
 * webview, applies edits (status, note) the webview requests, and jumps the editor to a review
 * item's location. Every handler is wrapped so a failure surfaces as an `{kind:'error'}` message
 * to the webview instead of crashing the extension host.
 */
export class ReviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private screen: Screen = { kind: 'sessions' };
  /** Global diff-presentation toggle mirrored from the webview; gates every editor decoration. */
  private diffVisible = true;
  private currentBundle: ReviewBundle | undefined;
  private watchers: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private daemonLink: DaemonLink | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** Disposed and replaced on every `resolveWebviewView` call so re-resolves don't leak listeners. */
  private messageHandler: vscode.Disposable | undefined;
  /** Last session list posted to the webview; `openSession` looks up here instead of re-listing
   * every bundle on disk (the refresh path already re-lists via `postSessions`). */
  private lastSessions: SessionSummary[] | undefined;
  /** Observers of {@link onDidPostMessage}. A plain `Set` rather than a `vscode.EventEmitter` so
   * this file keeps its type-only `vscode` import (see the boundary note in src/host.ts). */
  private readonly postListeners = new Set<(message: ToWebview) => void>();

  constructor(
    private readonly host: Host,
    private readonly mediaRoot: vscode.Uri,
  ) {
    this.disposables.push(this.host.onDidChangeWorkspaceFolders(() => this.setupWatchers()));
    this.setupWatchers();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.mediaRoot] };
    webviewView.webview.html = renderWebviewHtml(webviewView.webview, this.mediaRoot);
    // Re-resolves happen (e.g. the view container is fully torn down and reopened); dispose the
    // previous handler first so we don't accumulate one listener per resolve.
    this.messageHandler?.dispose();
    this.messageHandler = webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      void this.handleMessage(raw);
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
  }

  /** Re-posts whichever screen is currently active. Used by the manual refresh command too. */
  refresh(): void {
    this.refreshActiveScreen();
  }

  /**
   * Fires for every message posted to the webview, including ones posted before any webview has
   * been resolved. Exists as an observation seam: the extension-host integration suite (which
   * cannot read the webview's DOM) asserts on this stream to prove the real activity-bar view
   * completed its `ready` -> `sessions` round trip, and that a given action produced exactly one
   * `bundle` refresh. Production code does not subscribe.
   */
  onDidPostMessage(listener: (message: ToWebview) => void): { dispose(): void } {
    this.postListeners.add(listener);
    return {
      dispose: (): void => {
        this.postListeners.delete(listener);
      },
    };
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.disposeDaemonLink();
    this.messageHandler?.dispose();
    this.messageHandler = undefined;
    for (const disposable of [...this.watchers, ...this.disposables]) disposable.dispose();
    this.watchers = [];
    this.disposables.length = 0;
    this.postListeners.clear();
  }

  private disposeDaemonLink(): void {
    this.daemonLink?.dispose();
    this.daemonLink = undefined;
  }

  private setupWatchers(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = this.host
      .workspaceFolders()
      .map((root) =>
        this.host.watch(join(root, '.synergy', 'reviews'), () => this.scheduleRefresh()),
      );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshActiveScreen(), REFRESH_DEBOUNCE_MS);
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const message = parseFromWebview(raw);
    if (!message) return;

    try {
      switch (message.kind) {
        case 'ready':
          // The webview re-sends 'ready' on every re-init, not just first load - e.g. the view
          // container is reopened after being fully disposed (retainContextWhenHidden, set in
          // extension.ts, only survives hide/show, not disposal). Dispose any daemon link left
          // over from a prior bundle screen the same way 'backToSessions' does, or its SSE
          // socket leaks until the next openSession.
          this.disposeDaemonLink();
          this.screen = { kind: 'sessions' };
          this.postSessions();
          break;

        case 'backToSessions':
          this.disposeDaemonLink();
          this.screen = { kind: 'sessions' };
          this.postSessions();
          break;

        case 'openSession':
          this.openSession(message.workspaceId, message.revisionId);
          break;

        case 'setStatus':
          this.withActiveRef((projectRoot, ref) =>
            setItemStatus(projectRoot, ref, message.reviewItemId, message.status),
          );
          this.refreshActiveScreen();
          break;

        case 'setStatusBatch':
          this.withActiveRef((projectRoot, ref) => {
            for (const reviewItemId of message.reviewItemIds) {
              setItemStatus(projectRoot, ref, reviewItemId, message.status);
            }
          });
          this.refreshActiveScreen();
          break;

        case 'saveNote':
          this.withActiveRef((projectRoot, ref) =>
            saveNote(projectRoot, ref, message.reviewItemId, message.note),
          );
          this.refreshActiveScreen();
          break;

        case 'openHunk':
          await this.openHunk(message.reviewItemId);
          break;

        case 'openNativeDiff':
          await this.openNativeDiffFor(message.path, message.reviewItemId);
          break;

        case 'openFile':
          await this.openFullFile(message.path);
          break;

        case 'setDiffVisible':
          this.diffVisible = message.value;
          if (!message.value) this.host.clearDecorations();
          break;

        case 'showSnapshot':
          await this.showSnapshotFor(message.path);
          break;
      }
    } catch (error) {
      this.postError(error);
    }
  }

  private openSession(workspaceId: string, revisionId: string): void {
    // The webview can only have requested a session that was in the list it was just shown, so
    // the cache populated by the last `postSessions` call is always fresh enough here; fall back
    // to a fresh list only if we somehow have not posted one yet (e.g. a stray message before
    // 'ready').
    const sessions = this.lastSessions ?? listSessions(this.host.workspaceFolders());
    const match = sessions.find(
      (session) => session.workspaceId === workspaceId && session.revisionId === revisionId,
    );
    if (!match) {
      this.postError(new Error(`Session not found: ${workspaceId}`));
      return;
    }
    if (match.degraded) {
      // Never leave `screen` pointing at a bundle for a session that failed to load - the
      // webview already renders degraded cards as non-interactive, but guard here too in case a
      // stale/forged message slips through.
      this.postError(new Error(`Session is unavailable: ${match.degraded}`));
      return;
    }
    this.disposeDaemonLink();
    this.screen = {
      kind: 'bundle',
      projectRoot: match.projectRoot,
      ref: { workspaceId, revisionId },
    };
    this.refreshActiveScreen();
    this.daemonLink = tryConnectDaemon(match.projectRoot, { workspaceId, revisionId }, () =>
      this.scheduleRefresh(),
    );
  }

  private async openHunk(reviewItemId: string): Promise<void> {
    if (this.screen.kind !== 'bundle' || !this.currentBundle) {
      this.postError(new Error('No active session'));
      return;
    }
    const item = this.currentBundle.snapshot.items.find(
      (candidate) => candidate.id === reviewItemId,
    );
    if (!item) {
      this.postError(new Error(`Review item not found: ${reviewItemId}`));
      return;
    }
    await this.host.openFileAt(
      join(this.screen.projectRoot, item.path),
      item.range.start,
      item.range.end,
    );
    if (this.diffVisible) this.applyDecorationsFor(item);
  }

  /** Opens the full working-tree file (no hunk reveal) with all-hunk decorations when enabled. */
  private async openFullFile(path: string): Promise<void> {
    if (this.screen.kind !== 'bundle' || !this.currentBundle) {
      this.postError(new Error('No active session'));
      return;
    }
    await this.host.openFile(join(this.screen.projectRoot, path));
    if (!this.diffVisible || this.currentBundle.snapshot.kind !== 'diff') return;
    const file = this.currentBundle.snapshot.files.find((candidate) => candidate.path === path);
    if (!file) return;
    this.host.applyDecorations(fileDecorationRanges(file));
  }

  /** Best-effort: not every review item overlays onto a textual hunk (e.g. whole-file items). */
  private applyDecorationsFor(item: ReviewItem): void {
    if (!this.currentBundle || this.currentBundle.snapshot.kind !== 'diff') return;
    const file = this.currentBundle.snapshot.files.find(
      (candidate) => candidate.path === item.path,
    );
    if (!file) return;
    // `hunkDecorationRanges` throws only when no hunk in `file` matches `item.id` (e.g. a
    // whole-file item with no textual hunk); check the same condition here so the call below
    // can never throw for an unexpected reason and hide a real bug.
    const hasMatchingHunk = file.hunks.some((hunk) => hunk.reviewItemId === item.id);
    if (!hasMatchingHunk) return;
    this.host.applyDecorations(hunkDecorationRanges(file, item.id));
  }

  private async openNativeDiffFor(path: string, reviewItemId?: string): Promise<void> {
    if (this.screen.kind !== 'bundle') {
      this.postError(new Error('No active session'));
      return;
    }
    const revealRange = reviewItemId
      ? this.currentBundle?.snapshot.items.find((item) => item.id === reviewItemId)?.range
      : undefined;
    await openNativeDiff(this.screen.projectRoot, this.screen.ref, path, revealRange);
  }

  private async showSnapshotFor(path: string): Promise<void> {
    if (this.screen.kind !== 'bundle') {
      this.postError(new Error('No active session'));
      return;
    }
    await openSnapshotDocument(snapshotUri(this.screen.ref, path));
  }

  /**
   * Resolves content for the `synergy-review-snapshot:` scheme, wired in from `extension.ts` via
   * `registerSnapshotProvider`. Only resolves against whichever bundle is currently loaded in
   * this panel - a snapshot URI for a session that is not the active one returns `undefined`
   * (surfaced by the provider as an "unavailable" placeholder document) rather than silently
   * re-reading a different session's files from disk.
   */
  resolveSnapshotContent(uri: vscode.Uri): string | undefined {
    if (this.screen.kind !== 'bundle' || !this.currentBundle) return undefined;
    const { ref, path } = parseSnapshotUri(uri);
    if (
      ref.workspaceId !== this.screen.ref.workspaceId ||
      ref.revisionId !== this.screen.ref.revisionId
    ) {
      return undefined;
    }
    const resolved = snapshotContentFor(this.currentBundle.snapshot, path);
    if (!resolved) return undefined;
    const banner = resolved.isFullReconstruction
      ? `// Synergy captured snapshot: ${path} (full file as captured)\n\n`
      : `// Synergy captured snapshot: ${path} (captured hunks only - not a full-file reconstruction)\n\n`;
    return banner + resolved.text;
  }

  /**
   * Resolves content for the `synergy-review-base:` scheme (the left side of native diffs),
   * wired in from `extension.ts` via `registerBaseProvider`. Same active-bundle guard as
   * `resolveSnapshotContent`. Exact reconstructions (reverse-apply, git) return the raw text so
   * the diff aligns line-for-line; only the lossy hunks-only fallback gets a banner, since its
   * alignment is already approximate.
   */
  resolveBaseContent(uri: vscode.Uri): string | undefined {
    if (this.screen.kind !== 'bundle' || !this.currentBundle) return undefined;
    const { ref, path } = parseBaseUri(uri);
    if (
      ref.workspaceId !== this.screen.ref.workspaceId ||
      ref.revisionId !== this.screen.ref.revisionId
    ) {
      return undefined;
    }
    const resolved = resolveBaseContentFromProject(
      this.screen.projectRoot,
      this.currentBundle.snapshot,
      path,
    );
    if (!resolved) return undefined;
    if (resolved.origin === 'hunks-only') {
      return `// Synergy base content: ${path} (captured hunks only - not a full-file reconstruction)\n\n${resolved.text}`;
    }
    return resolved.text;
  }

  private withActiveRef(fn: (projectRoot: string, ref: ReviewRef) => void): void {
    if (this.screen.kind !== 'bundle') throw new Error('No active session');
    fn(this.screen.projectRoot, this.screen.ref);
  }

  private refreshActiveScreen(): void {
    if (this.screen.kind === 'sessions') {
      this.postSessions();
      return;
    }
    try {
      const bundle = loadBundle(this.screen.projectRoot, this.screen.ref);
      this.currentBundle = bundle;
      this.post({ kind: 'bundle', bundle: serializeBundle(this.screen.projectRoot, bundle) });
    } catch (error) {
      this.postError(error);
    }
  }

  private postSessions(): void {
    try {
      const sessions = listSessions(this.host.workspaceFolders());
      this.lastSessions = sessions;
      this.post({ kind: 'sessions', sessions });
    } catch (error) {
      this.postError(error);
    }
  }

  private postError(error: unknown): void {
    this.post({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }

  private post(message: ToWebview): void {
    void this.view?.webview.postMessage(message);
    for (const listener of this.postListeners) listener(message);
  }
}
