import { type FSWatcher, watch as fsWatch, mkdirSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { LISTENING_FILE, REVIEW_DONE_FILE } from '@synergy/state';
import { formatSseFrame } from './progress-stream.js';

const DEBOUNCE_MS = 80;

// Re-exported for existing importers of this module; the authoritative
// definition (and doc comment) now lives in @synergy/state's
// feedback-files.ts, shared with @synergy/cli's feedback-wait.
export { LISTENING_FILE };

/** Marker older than this is a dead process, not a listening agent. */
const LISTENING_STALE_MS = 90_000;

/** Re-check cadence so a killed agent flips the indicator without an fs event. */
const PRESENCE_POLL_MS = 45_000;

export function isAgentListening(sessionDir: string, now = Date.now()): boolean {
  try {
    const { mtimeMs } = statSync(join(sessionDir, LISTENING_FILE));
    return now - mtimeMs < LISTENING_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * GET /api/feedback/stream?session=<name>
 *
 * SSE notification channel for the comment set of one session: an initial
 * `connected` frame, then `feedback-changed`/`presence` frames as the
 * session's feedback dir changes. `.md` comment-file changes (new comment,
 * agent resolution) and `REVIEW_DONE_FILE` drops trigger `feedback-changed`;
 * `LISTENING_FILE` changes trigger a `presence` frame; an unknown or null
 * filename (platform-dependent) conservatively triggers both.
 * Frames carry no comment data — clients refetch GET /api/feedback, so the
 * payload can never go stale or race a half-written file.
 *
 * `watchFn` defaults to `node:fs`'s `watch` and exists as a test seam: the
 * real OS-level watch backend (FSEvents on macOS) has load-dependent startup
 * and delivery latency that can exceed any fixed test timeout under a fully
 * parallel suite run, so unit tests inject a synchronous fake instead of
 * racing real filesystem events.
 */
export function handleFeedbackStream(
  req: IncomingMessage,
  res: ServerResponse,
  feedbackDir: string,
  watchFn: typeof fsWatch = fsWatch,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const session = url.searchParams.get('session');
  if (!session || session.includes('/') || session.includes('\\') || session.includes('..')) {
    res.statusCode = 400;
    res.end('invalid session');
    return;
  }

  const sessionDir = join(feedbackDir, session);
  // The dir may not exist before the first comment; create it so the watcher
  // can attach now instead of the client reconnecting later.
  try {
    mkdirSync(sessionDir, { recursive: true });
  } catch {
    /* fall through — watch attach below reports the real failure mode */
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  res.write(formatSseFrame({ type: 'connected' }));

  const safeWrite = (payload: unknown) => {
    try {
      res.write(formatSseFrame(payload));
    } catch {
      /* client gone; close handler cleans up */
    }
  };

  let lastListening: boolean | undefined;
  const sendPresence = (force = false) => {
    const listening = isAgentListening(sessionDir);
    if (force || listening !== lastListening) {
      lastListening = listening;
      safeWrite({ type: 'presence', listening });
    }
  };

  sendPresence(true);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => safeWrite({ type: 'feedback-changed' }), DEBOUNCE_MS);
  };

  let watcher: FSWatcher | undefined;
  let watcherClosed = false;
  const closeWatcher = () => {
    if (watcherClosed) return;
    watcherClosed = true;
    watcher?.close();
  };
  try {
    watcher = watchFn(sessionDir, (_event, filename) => {
      const name = filename?.toString() ?? '';
      // The presence marker's heartbeat churns constantly; keep it off the
      // comment-refetch channel. Only .md comment files change the queue.
      if (name === LISTENING_FILE) {
        sendPresence();
        return;
      }
      if (name.endsWith('.md') || name === REVIEW_DONE_FILE) {
        schedule();
        return;
      }
      if (!name) {
        // Null/empty filename (platform-dependent): could be either kind of
        // change, so conservatively trigger both a refetch and a presence check.
        schedule();
        sendPresence();
      }
    });
    watcher.on('error', () => {
      // Watched dir vanished mid-stream (e.g. session deleted). Stop
      // watching but keep the SSE connection and presence poll alive —
      // the client falls back to manual refresh instead of the whole
      // response (or process) crashing on an uncaught watcher error.
      closeWatcher();
    });
  } catch {
    /* watch unsupported/dir vanished; client keeps manual refresh behavior */
  }

  // A killed agent leaves the marker behind with a decaying mtime — no fs
  // event will fire, so poll to flip the indicator to "not listening".
  const presencePoll = setInterval(() => sendPresence(), PRESENCE_POLL_MS);

  req.on('close', () => {
    if (timer) clearTimeout(timer);
    clearInterval(presencePoll);
    closeWatcher();
    res.end();
  });
}
