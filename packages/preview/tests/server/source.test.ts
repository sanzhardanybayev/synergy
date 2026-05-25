import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { handleSource } from '../../src/server/source.js';
import { makeMockReq, makeMockRes, makeTempDir } from './helpers.js';

describe('handleSource (GET /api/source)', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('returns the raw source for a file under sessionsDir', () => {
    const content = '# Title\n\nA paragraph with **prose**.\n';
    const tmp = makeTempDir({ 'foo/00-overview.mdx': content });
    cleanup = tmp.cleanup;

    const req = makeMockReq({ method: 'GET', url: '/api/source?file=foo/00-overview.mdx' });
    const { res, result } = makeMockRes();
    handleSource(req as unknown as IncomingMessage, res as unknown as ServerResponse, tmp.dir);

    const out = result();
    expect(out.statusCode).toBe(200);
    expect(out.json).toEqual({ file: 'foo/00-overview.mdx', source: content });
  });

  it('400 when the file parameter is missing', () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;

    const req = makeMockReq({ method: 'GET', url: '/api/source' });
    const { res, result } = makeMockRes();
    handleSource(req as unknown as IncomingMessage, res as unknown as ServerResponse, tmp.dir);

    expect(result().statusCode).toBe(400);
  });

  it('400 on path traversal', () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;

    const req = makeMockReq({ method: 'GET', url: '/api/source?file=../../etc/passwd' });
    const { res, result } = makeMockRes();
    handleSource(req as unknown as IncomingMessage, res as unknown as ServerResponse, tmp.dir);

    expect(result().statusCode).toBe(400);
  });

  it('404 when the file does not exist', () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;

    const req = makeMockReq({ method: 'GET', url: '/api/source?file=foo/missing.mdx' });
    const { res, result } = makeMockRes();
    handleSource(req as unknown as IncomingMessage, res as unknown as ServerResponse, tmp.dir);

    expect(result().statusCode).toBe(404);
  });
});
