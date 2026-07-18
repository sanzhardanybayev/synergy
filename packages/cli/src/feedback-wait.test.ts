import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync, type watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LISTENING_FILE,
  REVIEW_DONE_FILE,
  parseDuration,
  scanOpenComments,
  waitForFeedback,
} from './feedback-wait.js';

const SESSION = '2026-07-18-test-session';

let feedbackDir: string;

function writeComment(id: string, status: string, body = 'note'): void {
  const dir = join(feedbackDir, SESSION);
  mkdirSync(dir, { recursive: true });
  const content = [
    '---',
    `id: ${id}`,
    `session: ${SESSION}`,
    'file: 01-overview.mdx',
    `status: ${status}`,
    // Derive created from the id's timestamp segment so ordering assertions
    // exercise the created-based sort, not readdir order.
    `created: ${id.slice(0, 11)}${id.slice(11, 13)}:${id.slice(13, 15)}:${id.slice(15, 17)}.000Z`,
    '---',
    '',
    body,
  ].join('\n');
  writeFileSync(join(dir, `${id}.md`), content, 'utf8');
}

beforeEach(() => {
  feedbackDir = join(
    tmpdir(),
    `synergy-feedback-wait-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
});

afterEach(() => {
  rmSync(feedbackDir, { recursive: true, force: true });
});

describe('scanOpenComments', () => {
  it('returns only comments with status open, oldest first', () => {
    writeComment('2026-07-18T100000-aaaaaa', 'resolved');
    writeComment('2026-07-18T100001-bbbbbb', 'open', 'fix the title');
    writeComment('2026-07-18T100002-cccccc', 'rejected');
    writeComment('2026-07-18T100003-dddddd', 'open', 'second note');

    const open = scanOpenComments(feedbackDir, SESSION);

    expect(open.map((c) => c.id)).toEqual(['2026-07-18T100001-bbbbbb', '2026-07-18T100003-dddddd']);
    expect(open[0]?.body).toBe('fix the title');
  });

  it('returns empty list when the session feedback dir does not exist', () => {
    expect(scanOpenComments(feedbackDir, SESSION)).toEqual([]);
  });
});

describe('parseDuration', () => {
  it('parses seconds, minutes, and hours suffixes into milliseconds', () => {
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('rejects malformed values', () => {
    expect(() => parseDuration('10')).toThrow();
    expect(() => parseDuration('m10')).toThrow();
    expect(() => parseDuration('')).toThrow();
    expect(() => parseDuration('0m')).toThrow();
  });
});

describe('waitForFeedback', () => {
  it('returns queued open comments immediately without waiting', async () => {
    writeComment('2026-07-18T100001-bbbbbb', 'open');

    const result = await waitForFeedback({ feedbackDir, session: SESSION, timeoutMs: 5000 });

    expect(result.status).toBe('feedback');
    expect(result.comments.map((c) => c.id)).toEqual(['2026-07-18T100001-bbbbbb']);
  });

  it('wakes when a new open comment file appears during the wait', async () => {
    const pending = waitForFeedback({ feedbackDir, session: SESSION, timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 150));
    writeComment('2026-07-18T100009-eeeeee', 'open', 'late note');

    const result = await pending;

    expect(result.status).toBe('feedback');
    expect(result.comments.map((c) => c.id)).toEqual(['2026-07-18T100009-eeeeee']);
  });

  it('returns status ended (with final comments) when the review-done file appears', async () => {
    const pending = waitForFeedback({ feedbackDir, session: SESSION, timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 150));
    writeComment('2026-07-18T100010-ffffff', 'open', 'last words');
    writeFileSync(join(feedbackDir, SESSION, REVIEW_DONE_FILE), '', 'utf8');

    const result = await pending;

    expect(result.status).toBe('ended');
    expect(result.comments.map((c) => c.id)).toEqual(['2026-07-18T100010-ffffff']);
  });

  it('deletes a stale review-done file at start instead of ending immediately', async () => {
    mkdirSync(join(feedbackDir, SESSION), { recursive: true });
    writeFileSync(join(feedbackDir, SESSION, REVIEW_DONE_FILE), '', 'utf8');

    const result = await waitForFeedback({ feedbackDir, session: SESSION, timeoutMs: 300 });

    expect(result.status).toBe('timeout');
    expect(existsSync(join(feedbackDir, SESSION, REVIEW_DONE_FILE))).toBe(false);
  });

  it('maintains a listening marker while waiting and removes it on settle', async () => {
    const listeningPath = join(feedbackDir, SESSION, LISTENING_FILE);
    const pending = waitForFeedback({ feedbackDir, session: SESSION, timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 150));

    expect(existsSync(listeningPath)).toBe(true);

    writeComment('2026-07-18T100011-abcdef', 'open');
    await pending;

    expect(existsSync(listeningPath)).toBe(false);
  });

  it('removes the listening marker when the wait times out', async () => {
    const listeningPath = join(feedbackDir, SESSION, LISTENING_FILE);

    await waitForFeedback({ feedbackDir, session: SESSION, timeoutMs: 200 });

    expect(existsSync(listeningPath)).toBe(false);
  });

  it('returns status timeout when nothing happens before timeoutMs', async () => {
    const result = await waitForFeedback({ feedbackDir, session: SESSION, timeoutMs: 200 });

    expect(result.status).toBe('timeout');
    expect(result.comments).toEqual([]);
  });

  it('settles as timeout instead of crashing when the watcher emits an error', async () => {
    // A real FSWatcher 'error' (e.g. the session dir removed out from under
    // an active watch) is platform-dependent and not reliably triggerable in
    // a fast, portable test, so inject a fake watch() that emits one
    // deterministically. This exercises the same finish/cleanup path a real
    // watcher error would hit, proving the promise settles instead of
    // throwing an uncaught exception.
    const fakeWatcher = new EventEmitter() as ReturnType<typeof watch>;
    fakeWatcher.close = () => {};
    const watchImpl = (() => fakeWatcher) as typeof watch;

    const pending = waitForFeedback({
      feedbackDir,
      session: SESSION,
      timeoutMs: 10_000,
      watchImpl,
    });
    await new Promise((r) => setTimeout(r, 50));

    fakeWatcher.emit('error', new Error('ENOENT: session dir removed'));

    const result = await pending;

    expect(result).toEqual({ status: 'timeout', comments: [] });
    expect(existsSync(join(feedbackDir, SESSION, LISTENING_FILE))).toBe(false);
  });
});
