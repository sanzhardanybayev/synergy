import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyFeedbackBatch } from '../../src/server/feedback-batch.js';

let feedbackDir: string;
const SESSION = 'demo';

function writeComment(id: string) {
  const dir = join(feedbackDir, SESSION);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    `---\nid: ${id}\nstatus: open\nfile: 00-overview.mdx\n---\n\nplease fix\n`,
    'utf8',
  );
}

beforeEach(() => {
  feedbackDir = mkdtempSync(join(tmpdir(), 'synergy-fb-'));
});
afterEach(() => rmSync(feedbackDir, { recursive: true, force: true }));

describe('applyFeedbackBatch', () => {
  it('resolves and rejects multiple comments, reporting per-item results', () => {
    writeComment('a1');
    writeComment('b2');
    const out = applyFeedbackBatch(feedbackDir, [
      { id: 'a1', status: 'resolved', resolution: 'reworded intro' },
      { id: 'b2', status: 'rejected', rejection_reason: 'out of scope' },
    ]);
    expect(out.results).toEqual([
      { id: 'a1', ok: true },
      { id: 'b2', ok: true },
    ]);
    expect(readFileSync(join(feedbackDir, SESSION, 'a1.md'), 'utf8')).toContain('status: resolved');
    expect(readFileSync(join(feedbackDir, SESSION, 'b2.md'), 'utf8')).toContain('status: rejected');
  });

  it('continues past a missing comment and flags it', () => {
    writeComment('a1');
    const out = applyFeedbackBatch(feedbackDir, [
      { id: 'a1', status: 'resolved', resolution: 'x' },
      { id: 'missing', status: 'resolved', resolution: 'y' },
    ]);
    expect(out.results[0]).toEqual({ id: 'a1', ok: true });
    expect(out.results[1]!.ok).toBe(false);
    expect(out.results[1]!.error).toBeTruthy();
  });
});
