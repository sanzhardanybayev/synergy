import { join } from 'node:path';
import type { ReviewRange, ReviewRef } from '@synergy/review-core';
import * as vscode from 'vscode';
import { baseUri } from './base-provider.js';

/**
 * Opens VS Code's built-in diff view: the reconstructed pre-change base content (left, served by
 * the `synergy-review-base` content provider from base-provider.ts) against the file as it
 * currently sits on disk (right). Removed lines are therefore fully visible on the left side.
 *
 * Takes a `ReviewRef` rather than a `ReviewSnapshot` - `baseUri` needs the workspace id to build
 * a URI the registered content provider can resolve back to the right bundle, and a
 * `ReviewSnapshot` on its own does not carry that.
 *
 * `revealRange` (new-file coordinates, 1-indexed) scrolls the diff to a specific hunk so the
 * per-hunk "diff" affordance lands the reviewer on the change they clicked.
 */
export async function openNativeDiff(
  projectRoot: string,
  ref: ReviewRef,
  path: string,
  revealRange?: ReviewRange,
): Promise<void> {
  const options: vscode.TextDocumentShowOptions | undefined = revealRange
    ? { selection: new vscode.Range(revealRange.start - 1, 0, revealRange.end - 1, 0) }
    : undefined;
  await vscode.commands.executeCommand(
    'vscode.diff',
    baseUri(ref, path),
    vscode.Uri.file(join(projectRoot, path)),
    `Synergy: ${path} (base vs current)`,
    options,
  );
}
