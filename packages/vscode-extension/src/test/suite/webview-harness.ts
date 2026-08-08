import * as vscode from 'vscode';

/**
 * Drives the REAL `media/panel.js` inside a REAL Electron webview.
 *
 * The activity-bar view's webview is not reachable from the extension host - there is no API to
 * read its DOM or click inside it. So the suite creates its own `WebviewPanel`, loads the
 * extension's own HTML into it (the exact string `renderWebviewHtml` produced, CSP and all),
 * and hands it to the extension's provider as a `WebviewView`. From then on the panel behaves
 * exactly like the sidebar view: same script, same stylesheet, same message protocol.
 *
 * A small bridge script is injected AHEAD of `panel.js`, reusing the page's own CSP nonce (a
 * fresh nonce would be rejected - which is itself a check that the CSP is real). It:
 *  - captures `acquireVsCodeApi()` once and re-serves the same object to `panel.js`, because
 *    VS Code only allows a single acquisition per webview session; and
 *  - answers a handful of fixed commands (`__click`, `__query`, `__scrollTo`, `__scrollTop`,
 *    `__setNote`). They are fixed commands rather than an `eval` bridge on purpose: the CSP has
 *    no `unsafe-eval`, so an eval bridge could not run at all.
 */

export interface WebviewHarness {
  /** Messages `panel.js` (or the bridge) posted back to the host, newest last. */
  readonly received: unknown[];
  /** Resolves once `panel.js` has posted `ready`. */
  whenReady(): Promise<void>;
  /** Real DOM click on the `index`-th element matching `selector`. Throws if there is none. */
  click(selector: string, index?: number): Promise<void>;
  /** Number of elements matching `selector`, plus the first match's text content. */
  query(selector: string): Promise<{ count: number; text: string | null }>;
  /** Scrolls the pane and returns the offset that actually took effect. */
  scrollTo(top: number): Promise<number>;
  /** Current scroll offset of whichever element scrolls the pane. */
  scrollTop(): Promise<number>;
  /** Focuses the note textarea for `reviewItemId`; resolves to whether it became activeElement. */
  focusNote(reviewItemId: string): Promise<boolean>;
  /** Types into the note textarea for `reviewItemId` and blurs it (which posts `saveNote`). */
  setNote(reviewItemId: string, note: string): Promise<unknown>;
  dispose(): void;
}

/** Anything the webview posts that the harness itself owns. */
interface BridgeReply {
  kind: '__reply';
  id: number;
  value?: unknown;
  error?: string;
}

function isBridgeReply(value: unknown): value is BridgeReply {
  return typeof value === 'object' && value !== null && (value as BridgeReply).kind === '__reply';
}

/**
 * Reads back the nonce the extension put in its own CSP so the bridge can be served under it.
 */
function extractNonce(html: string): string {
  const match = /<script nonce="([^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error('could not read the webview CSP nonce from the extension HTML');
  return match[1];
}

const BRIDGE_SOURCE = `
(() => {
  const api = acquireVsCodeApi();
  // panel.js calls acquireVsCodeApi() too, and VS Code throws on a second acquisition.
  window.acquireVsCodeApi = () => api;
  const reply = (id, value, error) => api.postMessage({ kind: '__reply', id, value, error });
  const scroller = () => document.scrollingElement || document.documentElement;
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.kind !== 'string' || !message.kind.startsWith('__')) return;
    try {
      switch (message.kind) {
        case '__click': {
          const matches = document.querySelectorAll(message.selector);
          const target = matches[message.index || 0];
          if (!target) {
            throw new Error(
              'no element at index ' + (message.index || 0) + ' for ' + message.selector +
              ' (' + matches.length + ' matched)'
            );
          }
          target.click();
          reply(message.id, true);
          break;
        }
        case '__query': {
          const all = document.querySelectorAll(message.selector);
          const first = all[0];
          reply(message.id, { count: all.length, text: first ? first.textContent : null });
          break;
        }
        case '__scrollTo': {
          scroller().scrollTop = message.top;
          reply(message.id, scroller().scrollTop);
          break;
        }
        case '__scrollTop': {
          reply(message.id, scroller().scrollTop);
          break;
        }
        case '__focusNote': {
          const selector = '.hunk-note[data-review-item-id="' + message.reviewItemId + '"]';
          const textarea = document.querySelector(selector);
          if (!textarea) throw new Error('no note textarea for ' + message.reviewItemId);
          textarea.focus();
          reply(message.id, document.activeElement === textarea);
          break;
        }
        case '__setNote': {
          const selector = '.hunk-note[data-review-item-id="' + message.reviewItemId + '"]';
          const textarea = document.querySelector(selector);
          if (!textarea) throw new Error('no note textarea for ' + message.reviewItemId);
          let observed = false;
          textarea.addEventListener('blur', () => { observed = true; }, { once: true });
          textarea.focus();
          textarea.value = message.note;
          // focus()/blur() do set document.activeElement here, but Chromium does NOT deliver the
          // focus/blur EVENTS while the document lacks system focus - and a webview driven from
          // the extension host never has it. Dispatching the blur event is therefore the only way
          // to reach panel.js's real handler, and is equivalent: that handler reads nothing but
          // event.target.value.
          textarea.dispatchEvent(new FocusEvent('blur'));
          reply(message.id, {
            blurObserved: observed,
            connected: textarea.isConnected,
            value: textarea.value,
          });
          break;
        }
        default:
          break;
      }
    } catch (error) {
      reply(message.id, undefined, String(error));
    }
  });
})();
`;

function injectBridge(html: string): string {
  const nonce = extractNonce(html);
  return html.replace('<div id="app"></div>', (mount) => {
    return `${mount}\n  <script nonce="${nonce}">${BRIDGE_SOURCE}</script>`;
  });
}

/** Minimal `WebviewView` surface: the provider only touches `webview` and `onDidDispose`. */
function asWebviewView(panel: vscode.WebviewPanel): vscode.WebviewView {
  return {
    webview: panel.webview,
    onDidDispose: panel.onDidDispose,
    onDidChangeVisibility: panel.onDidChangeViewState as unknown as vscode.Event<void>,
    visible: panel.visible,
    viewType: 'synergyReview.panel',
    title: panel.title,
    show: (preserveFocus?: boolean) => panel.reveal(undefined, preserveFocus),
  } as unknown as vscode.WebviewView;
}

/**
 * Creates the panel, wires the bridge, and resolves the extension's provider against it. Returns
 * once the panel exists - call `whenReady()` to wait for `panel.js` to boot.
 */
export function createWebviewHarness(
  provider: vscode.WebviewViewProvider,
  mediaRoot: vscode.Uri,
): WebviewHarness {
  const panel = vscode.window.createWebviewPanel(
    'synergyReview.integrationHarness',
    'Synergy Review (integration harness)',
    { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
    { enableScripts: true, localResourceRoots: [mediaRoot], retainContextWhenHidden: true },
  );

  const received: unknown[] = [];
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  let readyResolve: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let nextId = 1;

  const subscription = panel.webview.onDidReceiveMessage((raw: unknown) => {
    received.push(raw);
    if (isBridgeReply(raw)) {
      const waiter = pending.get(raw.id);
      pending.delete(raw.id);
      if (!waiter) return;
      if (raw.error) waiter.reject(new Error(raw.error));
      else waiter.resolve(raw.value);
      return;
    }
    if (
      typeof raw === 'object' &&
      raw !== null &&
      (raw as { kind?: unknown }).kind === 'ready' &&
      readyResolve
    ) {
      readyResolve();
      readyResolve = undefined;
    }
  });

  function call<T>(kind: string, payload: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    const answered = new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`webview bridge call '${kind}' timed out`));
      }, 10_000);
    });
    void panel.webview.postMessage({ kind, id, ...payload });
    return answered;
  }

  // `resolveWebviewView` is what assigns the extension's own HTML (with its own nonce and CSP);
  // we then read that exact string back and re-assign it with the bridge prepended, so the
  // webview's single real load runs the bridge before `panel.js`.
  provider.resolveWebviewView(
    asWebviewView(panel),
    { state: undefined } as unknown as vscode.WebviewViewResolveContext,
    new vscode.CancellationTokenSource().token,
  );
  panel.webview.html = injectBridge(panel.webview.html);

  return {
    received,
    whenReady: () => ready,
    click: (selector, index = 0) => call<void>('__click', { selector, index }),
    query: (selector) => call<{ count: number; text: string | null }>('__query', { selector }),
    scrollTo: (top) => call<number>('__scrollTo', { top }),
    scrollTop: () => call<number>('__scrollTop'),
    focusNote: (reviewItemId) => call<boolean>('__focusNote', { reviewItemId }),
    setNote: (reviewItemId, note) => call<unknown>('__setNote', { reviewItemId, note }),
    dispose: () => {
      subscription.dispose();
      panel.dispose();
    },
  };
}
