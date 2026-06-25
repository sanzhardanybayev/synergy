import { type FSWatcher, watch } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { buildProgressResponse } from './progress.js';

export function formatSseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Build the initial SSE frame for a session's current progress. */
export function initialFrame(sessionsDir: string, session: string): string {
  return formatSseFrame(buildProgressResponse(sessionsDir, session));
}

const DEBOUNCE_MS = 80;

/**
 * GET /api/progress/stream?session=<name>
 * Sends the current payload immediately, then a fresh payload whenever the
 * session directory changes (debounced). Watches recursively where supported;
 * the client falls back to polling if the stream errors.
 */
export function handleProgressStream(
  req: IncomingMessage,
  res: ServerResponse,
  sessionsDir: string,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const session = url.searchParams.get('session');
  if (!session || session.includes('/') || session.includes('\\') || session.includes('..')) {
    res.statusCode = 400;
    res.end('invalid session');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = () => {
    try {
      res.write(formatSseFrame(buildProgressResponse(sessionsDir, session)));
    } catch {
      /* transient: a half-written file mid-rebuild; next event will catch up */
    }
  };

  send(); // initial paint

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(send, DEBOUNCE_MS);
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(join(sessionsDir, session), { recursive: true }, (_event, filename) => {
      const name = filename?.toString() ?? '';
      if (name.includes('.state') || name.includes('phases')) schedule();
    });
  } catch {
    /* recursive watch unsupported here; client poll fallback covers it */
  }

  req.on('close', () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
    res.end();
  });
}
