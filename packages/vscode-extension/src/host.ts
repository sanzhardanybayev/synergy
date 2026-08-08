import * as vscode from 'vscode';
import type { HunkDecorationRanges } from './editor/decoration-ranges.js';
import { applyHunkDecorations } from './editor/decorations.js';

/**
 * Host is the seam between the extension's domain logic and the `vscode` API.
 * Later tasks mock this interface in tests instead of importing `vscode` directly.
 * Only these files may import `vscode`: src/host.ts, src/extension.ts,
 * src/panel/webview-html.ts, src/panel/ReviewViewProvider.ts (type-only), and src/editor/*.ts.
 */
export interface Host {
  workspaceFolders(): string[]; // absolute fs paths
  onDidChangeWorkspaceFolders(cb: () => void): { dispose(): void };
  watch(globAbsoluteDir: string, cb: () => void): { dispose(): void };
  openFileAt(absPath: string, startLine: number, endLine: number): Promise<void>;
  /** Applies hunk highlight decorations to the active text editor, if any. No-op otherwise. */
  applyDecorations(ranges: HunkDecorationRanges): void;
  showError(message: string): void;
}

export function createVsCodeHost(): Host {
  return {
    workspaceFolders(): string[] {
      return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    },

    onDidChangeWorkspaceFolders(cb: () => void): { dispose(): void } {
      return vscode.workspace.onDidChangeWorkspaceFolders(cb);
    },

    watch(globAbsoluteDir: string, cb: () => void): { dispose(): void } {
      const pattern = new vscode.RelativePattern(globAbsoluteDir, '**/*');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const listeners = [watcher.onDidChange(cb), watcher.onDidCreate(cb), watcher.onDidDelete(cb)];
      return {
        dispose(): void {
          for (const listener of listeners) listener.dispose();
          watcher.dispose();
        },
      };
    },

    async openFileAt(absPath: string, startLine: number, endLine: number): Promise<void> {
      const doc = await vscode.workspace.openTextDocument(absPath);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const range = new vscode.Range(startLine - 1, 0, endLine - 1, 0);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(range.start, range.start);
    },

    applyDecorations(ranges: HunkDecorationRanges): void {
      const editor = vscode.window.activeTextEditor;
      if (editor) applyHunkDecorations(editor, ranges);
    },

    showError(message: string): void {
      void vscode.window.showErrorMessage(message);
    },
  };
}
