import * as vscode from 'vscode';
import { createVsCodeHost } from './host.js';
import { ReviewViewProvider } from './panel/ReviewViewProvider.js';

export function activate(context: vscode.ExtensionContext): void {
  const host = createVsCodeHost();
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  const provider = new ReviewViewProvider(host, mediaRoot);

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider('synergyReview.panel', provider),
    vscode.commands.registerCommand('synergy-review.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('synergy-review.openNativeDiff', () => {
      host.showError('Not implemented yet');
    }),
    vscode.commands.registerCommand('synergy-review.showSnapshot', () => {
      host.showError('Not implemented yet');
    }),
  );
}

export function deactivate(): void {}
