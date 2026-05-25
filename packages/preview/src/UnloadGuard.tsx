/**
 * UnloadGuard — prevents accidental loss of unsaved edits.
 *
 * When the buffer is dirty:
 *  1. Registers a `beforeunload` handler so the browser shows a confirm
 *     dialog when the tab is closed or the page is reloaded.
 *  2. Uses react-router-dom's `useBlocker` to intercept in-app route changes
 *     with a window.confirm prompt.
 *
 * Renders null — no visible output.
 */

import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';
import { useEditBuffer } from './EditBuffer.js';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UnloadGuard() {
  const buffer = useEditBuffer();
  const { isDirty, dirtyCount } = buffer;

  // -------------------------------------------------------------------------
  // beforeunload — browser tab close / page reload.
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Route change blocker — in-app navigation via react-router-dom.
  // useBlocker is stable across renders; it only fires the prompt when
  // isDirty is true.
  // -------------------------------------------------------------------------

  const blocker = useBlocker(isDirty);

  useEffect(() => {
    if (blocker.state !== 'blocked') return;

    const message = `You have ${dirtyCount} unsaved edit${dirtyCount !== 1 ? 's' : ''}.\n\nClick OK to leave (edits will be lost), or Cancel to stay and apply them.`;

    const confirmed = window.confirm(message);

    if (confirmed) {
      blocker.proceed();
    } else {
      blocker.reset();
    }
  }, [blocker, dirtyCount]);

  return null;
}
