import * as vscode from 'vscode';
import { disposeHunkDecorationTypes } from './editor/decorations.js';
import { registerSnapshotProvider } from './editor/snapshot-provider.js';
import { createVsCodeHost } from './host.js';
import { ReviewViewProvider } from './panel/ReviewViewProvider.js';

/**
 * What `vscode.extensions.getExtension('synergy.synergy-vscode').exports` resolves to.
 *
 * Nothing in the shipped product consumes this; it exists so the extension-host integration
 * suite can drive the SAME provider instance the activity-bar view uses (re-resolving it against
 * a test-owned webview panel) instead of constructing a second copy that would only prove the
 * source compiles, not that the packaged extension works.
 */
export interface SynergyReviewApi {
  readonly provider: ReviewViewProvider;
  readonly mediaRoot: vscode.Uri;
}

export function activate(context: vscode.ExtensionContext): SynergyReviewApi {
  const host = createVsCodeHost();
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  const provider = new ReviewViewProvider(host, mediaRoot);

  registerSnapshotProvider(context, (uri) => provider.resolveSnapshotContent(uri));

  context.subscriptions.push(
    provider,
    { dispose: () => disposeHunkDecorationTypes() },
    vscode.window.registerWebviewViewProvider('synergyReview.panel', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('synergy-review.refresh', () => provider.refresh()),
    // These command-palette entries have no file context of their own; the webview drives the
    // real openNativeDiff/showSnapshot flows (see ReviewViewProvider) with a specific path.
    vscode.commands.registerCommand('synergy-review.openNativeDiff', () => {
      host.showError('Open a drifted file from the Synergy Review panel to use this.');
    }),
    vscode.commands.registerCommand('synergy-review.showSnapshot', () => {
      host.showError('Open a drifted file from the Synergy Review panel to use this.');
    }),
  );

  return { provider, mediaRoot };
}

export function deactivate(): void {}
