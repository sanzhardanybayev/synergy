import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('synergy-review.refresh', () => {
      void vscode.window.showInformationMessage('Synergy Review: refreshed');
    }),
  );
}

export function deactivate(): void {}
