import { join } from 'node:path';
import type { ReviewBundle, ReviewRef } from '@synergy/review-core';
import type * as vscode from 'vscode';
import { listSessions, loadBundle, saveNote, setItemStatus } from '../data/sessions.js';
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
  private currentBundle: ReviewBundle | undefined;
  private watchers: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

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
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((raw: unknown) => {
        void this.handleMessage(raw);
      }),
    );
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
  }

  /** Re-posts whichever screen is currently active. Used by the manual refresh command too. */
  refresh(): void {
    this.refreshActiveScreen();
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const disposable of [...this.watchers, ...this.disposables]) disposable.dispose();
    this.watchers = [];
    this.disposables.length = 0;
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
          this.screen = { kind: 'sessions' };
          this.postSessions();
          break;

        case 'backToSessions':
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
        case 'showSnapshot':
          // The real commands land in a later task; for now surface that plainly.
          this.host.showError('Not implemented yet');
          break;
      }
    } catch (error) {
      this.postError(error);
    }
  }

  private openSession(workspaceId: string, revisionId: string): void {
    const match = listSessions(this.host.workspaceFolders()).find(
      (session) => session.workspaceId === workspaceId && session.revisionId === revisionId,
    );
    if (!match) {
      this.postError(new Error(`Session not found: ${workspaceId}`));
      return;
    }
    this.screen = {
      kind: 'bundle',
      projectRoot: match.projectRoot,
      ref: { workspaceId, revisionId },
    };
    this.refreshActiveScreen();
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
      this.post({ kind: 'sessions', sessions: listSessions(this.host.workspaceFolders()) });
    } catch (error) {
      this.postError(error);
    }
  }

  private postError(error: unknown): void {
    this.post({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }

  private post(message: ToWebview): void {
    void this.view?.webview.postMessage(message);
  }
}
