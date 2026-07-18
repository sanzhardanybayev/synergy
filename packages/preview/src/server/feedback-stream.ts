import { type FSWatcher, mkdirSync, statSync, watch } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { formatSseFrame } from './progress-stream.js';

const DEBOUNCE_MS = 80;

/**
 * Presence marker a waiting `synergy feedback wait` maintains (heartbeat
 * touch every 30s, removed on exit). Must match LISTENING_FILE in
 * @synergy/cli's feedback-wait.
 */
export const LISTENING_FILE = '.listening';

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
 * `connected` frame, then a `feedback-changed` frame whenever any file in the
 * session's feedback dir changes (new comment, agent resolution, review-done).
 * Frames carry no comment data — clients refetch GET /api/feedback, so the
 * payload can never go stale or race a half-written file.
 */
export function handleFeedbackStream(
  req: IncomingMessage,
  res: ServerResponse,
  feedbackDir: string,
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
  try {
    watcher = watch(sessionDir, (_event, filename) => {
      const name = filename?.toString() ?? '';
      // The presence marker's heartbeat churns constantly; keep it off the
      // comment-refetch channel. Only .md comment files change the queue.
      if (name === LISTENING_FILE) {
        sendPresence();
        return;
      }
      if (name.endsWith('.md')) schedule();
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
    watcher?.close();
    res.end();
  });
}
