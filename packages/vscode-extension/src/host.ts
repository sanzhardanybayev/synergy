import * as vscode from 'vscode';

/**
 * Host is the seam between the extension's domain logic and the `vscode` API.
 * Later tasks mock this interface in tests instead of importing `vscode` directly.
 * Only this file and extension.ts/webview host files may import `vscode`.
 */
export interface Host {
  workspaceFolders(): string[]; // absolute fs paths
  onDidChangeWorkspaceFolders(cb: () => void): { dispose(): void };
  watch(globAbsoluteDir: string, cb: () => void): { dispose(): void };
  openFileAt(absPath: string, startLine: number, endLine: number): Promise<void>;
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
      watcher.onDidChange(cb);
      watcher.onDidCreate(cb);
      watcher.onDidDelete(cb);
      return watcher;
    },

    async openFileAt(absPath: string, startLine: number, endLine: number): Promise<void> {
      const doc = await vscode.workspace.openTextDocument(absPath);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const range = new vscode.Range(startLine - 1, 0, endLine - 1, 0);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(range.start, range.start);
    },

    showError(message: string): void {
      void vscode.window.showErrorMessage(message);
    },
  };
}
