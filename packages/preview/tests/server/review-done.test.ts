import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REVIEW_DONE_FILE, handleReviewDone } from '../../src/server/review-done.js';
import { makeMockReq, makeMockRes, makeTempDir } from './helpers.js';

const SESSION = '2026-07-18-checkout-flow';

async function callReviewDone(feedbackDir: string, body: unknown) {
  const req = makeMockReq({ method: 'POST', url: '/api/review-done', body });
  const { res, result } = makeMockRes();
  await handleReviewDone(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    feedbackDir,
  );
  return result();
}

describe('handleReviewDone', () => {
  let temp: ReturnType<typeof makeTempDir>;

  afterEach(() => temp?.cleanup());

  it('writes the review-done control file into the session feedback dir', async () => {
    temp = makeTempDir();

    const result = await callReviewDone(temp.dir, { session: SESSION });

    expect(result.statusCode).toBe(200);
    expect(existsSync(join(temp.dir, SESSION, REVIEW_DONE_FILE))).toBe(true);
  });

  it('rejects a session name with path separators', async () => {
    temp = makeTempDir();

    const result = await callReviewDone(temp.dir, { session: '../escape' });

    expect(result.statusCode).toBe(400);
    expect(existsSync(join(temp.dir, '..', 'escape'))).toBe(false);
  });

  it('rejects a missing session field', async () => {
    temp = makeTempDir();

    const result = await callReviewDone(temp.dir, {});

    expect(result.statusCode).toBe(400);
  });
});
