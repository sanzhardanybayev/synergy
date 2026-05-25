import { readFileSync, readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterEach, describe, expect, it } from 'vitest';
import {
  handleFeedbackGet,
  handleFeedbackPatch,
  handleFeedbackPost,
} from '../../src/server/feedback.js';
import { makeMockReq, makeMockRes, makeTempDir } from './helpers.js';

const ANCHOR = {
  lineStart: 10,
  colStart: 4,
  lineEnd: 10,
  colEnd: 7,
  before: 'sign in via ',
  selected: 'SSO',
  after: ' and redirect',
};

async function callPost(feedbackDir: string, body: unknown) {
  const req = makeMockReq({ method: 'POST', url: '/api/feedback', body });
  const { res, result } = makeMockRes();
  await handleFeedbackPost(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    feedbackDir,
  );
  return result();
}

function callGet(feedbackDir: string, session: string) {
  const req = makeMockReq({ method: 'GET', url: `/api/feedback?session=${session}` });
  const { res, result } = makeMockRes();
  handleFeedbackGet(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    feedbackDir,
  );
  return result();
}

async function callPatch(feedbackDir: string, id: string, body: unknown) {
  const req = makeMockReq({ method: 'PATCH', url: `/api/feedback/${id}`, body });
  const { res, result } = makeMockRes();
  await handleFeedbackPatch(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    feedbackDir,
    id,
  );
  return result();
}

describe('handleFeedbackPost', () => {
  let temp: ReturnType<typeof makeTempDir>;

  afterEach(() => temp?.cleanup());

  it('writes a file with correct frontmatter including line/col', async () => {
    temp = makeTempDir({});

    const r = await callPost(temp.dir, {
      session: '2026-05-25-foo',
      file: 'phases/01-core/spec.mdx',
      anchor: ANCHOR,
      body: 'Should this cover SAML?',
    });

    expect(r.statusCode).toBe(200);
    const resp = r.json as Record<string, unknown>;
    expect(typeof resp.id).toBe('string');
    expect(typeof resp.path).toBe('string');

    const id = resp.id as string;
    const absFile = join(temp.dir, '2026-05-25-foo', `${id}.md`);
    const raw = readFileSync(absFile, 'utf8');
    const parsed = matter(raw);

    expect(parsed.data.id).toBe(id);
    expect(parsed.data.session).toBe('2026-05-25-foo');
    expect(parsed.data.file).toBe('phases/01-core/spec.mdx');
    expect(parsed.data.status).toBe('open');
    // gray-matter parses ISO timestamps as Date objects
    expect(typeof parsed.data.created === 'string' || parsed.data.created instanceof Date).toBe(
      true,
    );

    const anchor = parsed.data.anchor as Record<string, unknown>;
    expect(anchor.lineStart).toBe(10);
    expect(anchor.colStart).toBe(4);
    expect(anchor.lineEnd).toBe(10);
    expect(anchor.colEnd).toBe(7);
    expect(anchor.selected).toBe('SSO');

    expect(parsed.content.trim()).toBe('Should this cover SAML?');
  });

  it('rejects bad session name with slashes', async () => {
    temp = makeTempDir({});
    const r = await callPost(temp.dir, {
      session: '../evil',
      file: 'spec.mdx',
      anchor: ANCHOR,
      body: 'test',
    });
    expect(r.statusCode).toBe(400);
  });

  it('returns 400 on missing required fields', async () => {
    temp = makeTempDir({});
    const r = await callPost(temp.dir, { session: 'foo', file: 'spec.mdx' });
    expect(r.statusCode).toBe(400);
  });
});

describe('handleFeedbackGet', () => {
  let temp: ReturnType<typeof makeTempDir>;

  afterEach(() => temp?.cleanup());

  it('returns empty list when session dir does not exist', () => {
    temp = makeTempDir({});
    const r = callGet(temp.dir, 'missing-session');
    expect(r.statusCode).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body.comments).toEqual([]);
  });

  it('returns comments sorted by created ascending', async () => {
    temp = makeTempDir({});

    // Post two comments; they'll have IDs generated from Date.now() + random.
    // We can't control exact order from generateCommentId, so we write files
    // manually with known created timestamps.
    const makeFm = (id: string, created: string) =>
      `---\nid: ${id}\nsession: sess\nfile: spec.mdx\nstatus: open\ncreated: ${created}\nanchor:\n  lineStart: 1\n  colStart: 0\n  lineEnd: 1\n  colEnd: 3\n  before: ""\n  selected: "foo"\n  after: ""\n---\n\nA comment\n`;

    const t = makeTempDir({
      'sess/b-later.md': makeFm('b', '2026-05-25T10:00:00Z'),
      'sess/a-earlier.md': makeFm('a', '2026-05-25T09:00:00Z'),
    });
    // We constructed the files manually in the right feedbackDir
    const r = callGet(t.dir, 'sess');
    t.cleanup();

    const body = r.json as Record<string, unknown>;
    const comments = body.comments as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(2);
    // Sorted ascending by created
    expect(comments[0]!.id).toBe('a');
    expect(comments[1]!.id).toBe('b');
  });
});

describe('handleFeedbackPatch', () => {
  let temp: ReturnType<typeof makeTempDir>;

  afterEach(() => temp?.cleanup());

  it('updates status to resolved and preserves body', async () => {
    const id = 'test-comment-id';
    const initialContent = `---\nid: ${id}\nsession: sess\nfile: spec.mdx\nstatus: open\ncreated: 2026-05-25T09:00:00Z\nanchor:\n  lineStart: 1\n  colStart: 0\n  lineEnd: 1\n  colEnd: 3\n  before: ""\n  selected: "foo"\n  after: ""\n---\n\nOriginal comment body.\n`;
    temp = makeTempDir({ [`sess/${id}.md`]: initialContent });

    const r = await callPatch(temp.dir, id, {
      status: 'resolved',
      resolution: 'Fixed in PR #42',
    });

    expect(r.statusCode).toBe(200);
    const files = readdirSync(join(temp.dir, 'sess'));
    const updated = readFileSync(join(temp.dir, 'sess', `${id}.md`), 'utf8');
    const parsed = matter(updated);
    expect(parsed.data.status).toBe('resolved');
    expect(parsed.data.resolution).toBe('Fixed in PR #42');
    expect(typeof parsed.data.resolved_at).toBe('string');
    // Body preserved
    expect(parsed.content.trim()).toContain('Original comment body.');
    // files count unchanged
    expect(files).toHaveLength(1);
  });

  it('updates status to rejected', async () => {
    const id = 'reject-id';
    const initialContent = `---\nid: ${id}\nsession: sess\nfile: spec.mdx\nstatus: open\ncreated: 2026-05-25T09:00:00Z\nanchor:\n  lineStart: 1\n  colStart: 0\n  lineEnd: 1\n  colEnd: 3\n  before: ""\n  selected: "x"\n  after: ""\n---\n\nBody.\n`;
    temp = makeTempDir({ [`sess/${id}.md`]: initialContent });

    const r = await callPatch(temp.dir, id, {
      status: 'rejected',
      rejection_reason: 'Out of scope',
    });

    expect(r.statusCode).toBe(200);
    const updated = readFileSync(join(temp.dir, 'sess', `${id}.md`), 'utf8');
    const parsed = matter(updated);
    expect(parsed.data.status).toBe('rejected');
    expect(parsed.data.rejection_reason).toBe('Out of scope');
    expect(parsed.data.resolved_at).toBeUndefined();
  });

  it('returns 404 for unknown id', async () => {
    temp = makeTempDir({});
    const r = await callPatch(temp.dir, 'no-such-id', { status: 'resolved' });
    expect(r.statusCode).toBe(404);
  });

  it('returns 400 for invalid id with path separator', async () => {
    temp = makeTempDir({});
    const r = await callPatch(temp.dir, 'some/id', { status: 'resolved' });
    expect(r.statusCode).toBe(400);
  });
});
