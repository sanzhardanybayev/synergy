import type { ReviewRef } from '@synergy/review-core';
import * as vscode from 'vscode';

/** URI scheme for read-only "pre-change base content" virtual documents (left side of diffs). */
export const BASE_SCHEME = 'synergy-review-base';

/**
 * Builds a `synergy-review-base:` URI for `path` inside the given review revision. Same shape as
 * `snapshotUri` (see snapshot-provider.ts): the path stays a real path so language detection and
 * the diff tab title read naturally; the ref round-trips through the query string.
 */
export function baseUri(ref: ReviewRef, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BASE_SCHEME,
    path: path.startsWith('/') ? path : `/${path}`,
    query: `workspaceId=${encodeURIComponent(ref.workspaceId)}&revisionId=${encodeURIComponent(ref.revisionId)}`,
  });
}

/** Inverse of `baseUri`. */
export function parseBaseUri(uri: vscode.Uri): { ref: ReviewRef; path: string } {
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
 * Registers the `TextDocumentContentProvider` for `BASE_SCHEME`. `resolve` is supplied by the
 * caller (see `ReviewViewProvider.resolveBaseContent`) because resolution needs the
 * currently-loaded review bundle, which this module has no knowledge of.
 */
export function registerBaseProvider(
  context: vscode.ExtensionContext,
  resolve: (uri: vscode.Uri) => string | undefined,
): void {
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return resolve(uri) ?? `Synergy: base content unavailable for ${uri.path}`;
    },
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, provider),
  );
}
