import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

function createNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Renders the webview shell: a strict CSP (script execution limited to our own nonce-tagged
 * script, styles limited to the webview's own origin), `panel.css`/`panel.js` addressed through
 * `asWebviewUri` so they resolve under the `vscode-webview:` scheme, and an empty `#app` mount
 * point that `panel.js` populates.
 */
export function renderWebviewHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const nonce = createNonce();
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.js'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri.toString()}" />
  <title>Synergy Review</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
