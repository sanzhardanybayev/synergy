import type { ReviewRange } from '@synergy/review-core';
import * as vscode from 'vscode';
import type { HunkDecorationRanges } from './decoration-ranges.js';

export type { HunkDecorationRanges } from './decoration-ranges.js';
export { hunkDecorationRanges } from './decoration-ranges.js';

/**
 * Decoration types are process-wide singletons in VS Code's API - creating one per call would
 * leak. Both are created lazily on first use and torn down once via `disposeHunkDecorationTypes`,
 * which `extension.ts` wires into its subscriptions so `deactivate` cleans them up.
 */
let addedDecorationType: vscode.TextEditorDecorationType | undefined;
let removedDecorationType: vscode.TextEditorDecorationType | undefined;

function getAddedDecorationType(): vscode.TextEditorDecorationType {
  if (!addedDecorationType) {
    addedDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    });
  }
  return addedDecorationType;
}

function getRemovedDecorationType(): vscode.TextEditorDecorationType {
  if (!removedDecorationType) {
    removedDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderStyle: 'solid',
      borderWidth: '0 0 2px 0',
      borderColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    });
  }
  return removedDecorationType;
}

function toEditorRange(range: ReviewRange): vscode.Range {
  return new vscode.Range(range.start - 1, 0, range.end - 1, 0);
}

/** Thin wiring around the pure `HunkDecorationRanges` math: not unit-tested, kept deliberately small. */
export function applyHunkDecorations(
  editor: vscode.TextEditor,
  ranges: HunkDecorationRanges,
): void {
  editor.setDecorations(getAddedDecorationType(), ranges.added.map(toEditorRange));
  editor.setDecorations(getRemovedDecorationType(), ranges.removed.map(toEditorRange));
}

/** Disposes the lazily-created decoration types. Safe to call even if they were never created. */
export function disposeHunkDecorationTypes(): void {
  addedDecorationType?.dispose();
  removedDecorationType?.dispose();
  addedDecorationType = undefined;
  removedDecorationType = undefined;
}
