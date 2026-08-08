import { join } from 'node:path';
import type { ReviewRef } from '@synergy/review-core';
import * as vscode from 'vscode';
import { snapshotUri } from './snapshot-provider.js';

/**
 * Opens VS Code's built-in diff view: the captured snapshot (left, served by the
 * `synergy-review-snapshot` content provider from snapshot-provider.ts) against the file as it
 * currently sits on disk (right).
 *
 * Takes a `ReviewRef` rather than a `ReviewSnapshot` - `snapshotUri` needs the workspace id to
 * build a URI the registered content provider can resolve back to the right bundle, and a
 * `ReviewSnapshot` on its own does not carry that.
 */
export async function openNativeDiff(
  projectRoot: string,
  ref: ReviewRef,
  path: string,
): Promise<void> {
  await vscode.commands.executeCommand(
    'vscode.diff',
    snapshotUri(ref, path),
    vscode.Uri.file(join(projectRoot, path)),
    `Synergy: ${path} (captured vs current)`,
  );
}
