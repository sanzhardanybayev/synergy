import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleEdit } from '../../src/server/edit.js';
import { makeMockReq, makeMockRes, makeTempDir } from './helpers.js';

type Temp = ReturnType<typeof makeTempDir>;

describe('handleEdit', () => {
  let temp: Temp;

  beforeEach(() => {
    temp = makeTempDir({});
  });
  afterEach(() => {
    temp.cleanup();
  });

  async function call(body: unknown, files: Record<string, string> = {}) {
    const t = makeTempDir(files);
    const req = makeMockReq({ method: 'PUT', url: '/api/edit', body });
    const { res, result } = makeMockRes();
    await handleEdit(req as unknown as IncomingMessage, res as unknown as ServerResponse, t.dir);
    t.cleanup();
    return result();
  }

  it('replaces a span and preserves trailing newline', async () => {
    const content = 'line one\nold text here\nline three\n';
    const t = makeTempDir({ 'session/spec.mdx': content });
    const req = makeMockReq({
      method: 'PUT',
      url: '/api/edit',
      body: {
        file: 'session/spec.mdx',
        sourceStart: { line: 2, col: 0 },
        sourceEnd: { line: 2, col: 13 },
        expectedText: 'old text here',
        newText: 'new text here',
      },
    });
    const { res, result } = makeMockRes();
    await handleEdit(req as unknown as IncomingMessage, res as unknown as ServerResponse, t.dir);
    t.cleanup();
    const r = result();
    expect(r.statusCode).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.newSize).toBe('number');
  });

  it('returns 409 on expectedText mismatch', async () => {
    const r = await call(
      {
        file: 'sess/spec.mdx',
        sourceStart: { line: 1, col: 0 },
        sourceEnd: { line: 1, col: 8 },
        expectedText: 'WRONG',
        newText: 'anything',
      },
      { 'sess/spec.mdx': 'line one\n' },
    );
    expect(r.statusCode).toBe(409);
    const body = r.json as Record<string, unknown>;
    expect(body.error).toBe('stale_range');
    expect(typeof body.currentText).toBe('string');
  });

  it('returns 404 for missing file', async () => {
    const r = await call({
      file: 'nope/spec.mdx',
      sourceStart: { line: 1, col: 0 },
      sourceEnd: { line: 1, col: 4 },
      expectedText: 'text',
      newText: 'text',
    });
    expect(r.statusCode).toBe(404);
  });

  it('returns 400 on path traversal', async () => {
    const r = await call({
      file: '../../etc/passwd',
      sourceStart: { line: 1, col: 0 },
      sourceEnd: { line: 1, col: 4 },
      expectedText: 'root',
      newText: 'root',
    });
    expect(r.statusCode).toBe(400);
    const body = r.json as Record<string, unknown>;
    expect(body.error).toBe('bad_path');
  });

  it('returns 400 for malformed body', async () => {
    const r = await call({ foo: 'bar' });
    expect(r.statusCode).toBe(400);
  });
});
