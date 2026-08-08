import type { ReviewRef } from '@synergy/review-core';
import * as vscode from 'vscode';

/** URI scheme for read-only "captured snapshot" virtual documents. */
export const SNAPSHOT_SCHEME = 'synergy-review-snapshot';

/**
 * Builds a `synergy-review-snapshot:` URI for `path` inside the given review revision. The path
 * is kept as the URI path (not just a query param) so VS Code's language detection and the tab
 * title both read as the real file name; the ref travels in the query string so
 * `parseSnapshotUri` can round-trip it.
 */
export function snapshotUri(ref: ReviewRef, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SNAPSHOT_SCHEME,
    path: path.startsWith('/') ? path : `/${path}`,
    query: `workspaceId=${encodeURIComponent(ref.workspaceId)}&revisionId=${encodeURIComponent(ref.revisionId)}`,
  });
}

/** Inverse of `snapshotUri`. */
export function parseSnapshotUri(uri: vscode.Uri): { ref: ReviewRef; path: string } {
  const params = new URLSearchParams(uri.query);
  return {
    ref: {
      workspaceId: params.get('workspaceId') ?? '',
      revisionId: params.get('revisionId') ?? '',
    },
    path: uri.path.replace(/^\//, ''),
  };
}

/**
 * Registers the `TextDocumentContentProvider` for `SNAPSHOT_SCHEME`. `resolve` is supplied by the
 * caller (see `ReviewViewProvider.resolveSnapshotContent`) because content resolution needs the
 * currently-loaded review bundle, which this module has no knowledge of - it only owns the URI
 * scheme and the VS Code registration plumbing.
 */
export function registerSnapshotProvider(
  context: vscode.ExtensionContext,
  resolve: (uri: vscode.Uri) => string | undefined,
): void {
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return resolve(uri) ?? `Synergy: captured snapshot unavailable for ${uri.path}`;
    },
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, provider),
  );
}
