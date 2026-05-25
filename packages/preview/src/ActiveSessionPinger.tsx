/**
 * ActiveSessionPinger — headless component that keeps .synergy/active-session
 * up to date.
 *
 * Pings POST /api/active-session on:
 *  - mount
 *  - session prop change
 *  - window focus
 *
 * Debounce: rapid duplicate pings (within 1 second) are swallowed.
 * Returns null — renders nothing.
 */

import { useCallback, useEffect, useRef } from 'react';
import { postActiveSession } from './api.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ActiveSessionPingerProps {
  /** The session slug, e.g. "2026-05-25-foo-feature". */
  session: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 1000;

export function ActiveSessionPinger({ session }: ActiveSessionPingerProps) {
  const lastPingRef = useRef<number>(0);
  const sessionRef = useRef<string>(session);

  // Keep sessionRef in sync so the focus handler always uses the latest session.
  sessionRef.current = session;

  const ping = useCallback((s: string) => {
    const now = Date.now();
    if (now - lastPingRef.current < DEBOUNCE_MS) return;
    lastPingRef.current = now;
    // Fire-and-forget — errors are non-fatal; we don't surface them to the user,
    // but log so a broken endpoint (which would leave /synergy-feedback reading a
    // stale active-session) is diagnosable in devtools.
    void postActiveSession(s).catch((err) => {
      console.warn('[synergy] active-session ping failed:', err);
    });
  }, []);

  // Ping on mount and whenever session changes.
  useEffect(() => {
    ping(session);
  }, [session, ping]);

  // Ping on window focus.
  useEffect(() => {
    const onFocus = () => ping(sessionRef.current);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [ping]);

  return null;
}
