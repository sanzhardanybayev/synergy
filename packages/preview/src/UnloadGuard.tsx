/**
 * UnloadGuard — prevents accidental loss of unsaved edits.
 *
 * When the buffer is dirty, registers a `beforeunload` handler so the browser
 * shows a confirm dialog on tab close / page reload.
 *
 * NOTE: an in-app route-change guard (react-router `useBlocker`) is NOT used
 * here — `useBlocker` requires a *data router* (`createBrowserRouter` +
 * `RouterProvider`), but the app mounts a plain `<BrowserRouter>`. Calling it
 * throws and takes down the whole tree. Upgrading to a data router is a
 * follow-up; the `beforeunload` guard covers the common loss case (close/reload).
 *
 * Renders null — no visible output.
 */

import { useEffect } from 'react';
import { useEditBuffer } from './EditBuffer.js';

export function UnloadGuard() {
  const { isDirty } = useEditBuffer();

  useEffect(() => {
    if (!isDirty) return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome/Edge require returnValue to be set.
      e.returnValue = '';
    };

    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  return null;
}
