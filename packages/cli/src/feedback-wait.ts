import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

/**
 * Control file the preview server writes into a session's feedback dir when
 * the user clicks "Done reviewing". Its appearance ends an active wait.
 */
export const REVIEW_DONE_FILE = '.review-done';

/**
 * Presence marker maintained while a wait is active. The preview's feedback
 * SSE stream stats this file (mtime freshness) to show "agent listening" in
 * the browser. Touched on a heartbeat so a killed process reads as stale.
 */
export const LISTENING_FILE = '.listening';

const LISTENING_HEARTBEAT_MS = 30_000;

export interface FeedbackComment {
  id: string;
  session: string;
  file: string;
  status: string;
  created: string;
  body: string;
  [key: string]: unknown;
}

/**
 * Read every `<id>.md` under `<feedbackDir>/<session>/` and return the ones
 * with `status: open`, sorted by `created` ascending (ISO strings sort
 * chronologically).
 */
export function scanOpenComments(feedbackDir: string, session: string): FeedbackComment[] {
  const sessionDir = join(feedbackDir, session);
  if (!existsSync(sessionDir)) return [];

  const comments: FeedbackComment[] = [];
  for (const filename of readdirSync(sessionDir)) {
    if (!filename.endsWith('.md')) continue;
    try {
      const raw = readFileSync(join(sessionDir, filename), 'utf8');
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;
      if (data.status !== 'open') continue;
      comments.push({
        ...data,
        body: parsed.content.trim(),
      } as FeedbackComment);
    } catch {
      // A half-written or corrupt comment must not abort the scan; the next
      // watch event re-scans and picks it up once fully written.
    }
  }

  comments.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
  return comments;
}

/** Parse a `--for` duration like `45s`, `10m`, `2h` into milliseconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)([smh])$/.exec(value);
  if (!match) {
    throw new Error(`invalid duration "${value}" — use a number with s, m, or h (e.g. 10m)`);
  }
  const amount = Number(match[1]);
  if (amount <= 0) {
    throw new Error(`invalid duration "${value}" — must be greater than zero`);
  }
  const unitMs = match[2] === 's' ? 1000 : match[2] === 'm' ? 60_000 : 3_600_000;
  return amount * unitMs;
}

export interface WaitResult {
  status: 'feedback' | 'ended' | 'timeout';
  comments: FeedbackComment[];
}

export interface WaitOptions {
  feedbackDir: string;
  session: string;
  /** Bounded wait; omit to wait indefinitely. */
  timeoutMs?: number;
}

const WATCH_DEBOUNCE_MS = 60;

/**
 * Resolve as soon as the session has open comments (immediately if any are
 * already queued), when the review-done control file appears (final comments
 * ride along), or when `timeoutMs` elapses. A stale control file left over
 * from a previous review round is consumed at start so it cannot end the new
 * wait before the user has said anything.
 */
export function waitForFeedback(options: WaitOptions): Promise<WaitResult> {
  const { feedbackDir, session, timeoutMs } = options;
  const sessionDir = join(feedbackDir, session);
  // fs.watch requires the directory to exist; comments may not have been
  // written yet when the agent starts listening.
  mkdirSync(sessionDir, { recursive: true });

  const doneFile = join(sessionDir, REVIEW_DONE_FILE);
  rmSync(doneFile, { force: true });

  const queued = scanOpenComments(feedbackDir, session);
  if (queued.length > 0) {
    return Promise.resolve({ status: 'feedback', comments: queued });
  }

  const listeningFile = join(sessionDir, LISTENING_FILE);
  const touchListening = () => {
    try {
      writeFileSync(listeningFile, `${new Date().toISOString()}\n`, 'utf8');
    } catch {
      /* presence is best-effort; the wait itself must not die over it */
    }
  };
  touchListening();
  const listeningHeartbeat = setInterval(touchListening, LISTENING_HEARTBEAT_MS);
  listeningHeartbeat.unref?.();

  return new Promise((resolvePromise) => {
    let settled = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const watcher = watch(sessionDir, (_event, filename) => {
      // The heartbeat touches .listening inside the watched dir; reacting to
      // it would wake the scan every 30s for nothing.
      if (filename?.toString() === LISTENING_FILE) return;
      schedule();
    });

    const cleanup = () => {
      if (debounce) clearTimeout(debounce);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      clearInterval(listeningHeartbeat);
      rmSync(listeningFile, { force: true });
      watcher.close();
    };

    const finish = (result: WaitResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };

    const check = () => {
      if (settled) return;
      // Read comments before consuming the control file so the final batch
      // and the end signal arrive together.
      const open = scanOpenComments(feedbackDir, session);
      if (existsSync(doneFile)) {
        rmSync(doneFile, { force: true });
        finish({ status: 'ended', comments: open });
        return;
      }
      if (open.length > 0) {
        finish({ status: 'feedback', comments: open });
      }
    };

    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(check, WATCH_DEBOUNCE_MS);
    };

    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => finish({ status: 'timeout', comments: [] }), timeoutMs);
    }

    // A comment could land between the initial scan and the watcher attach.
    schedule();
  });
}
