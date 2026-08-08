/**
 * Ambient declarations for the webview execution context. `acquireVsCodeApi` is injected by
 * VS Code into the webview's global scope; it does not exist in any published `@types` package.
 */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  /** Persisted webview state - survives disposal, unlike in-memory variables. */
  getState(): { diffVisible?: boolean } | undefined;
  setState(state: { diffVisible?: boolean }): void;
};
