import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleStatus } from '../../src/server/status.js';
import { makeMockReq, makeMockRes, makeTempDir } from './helpers.js';

async function callStatus(sessionsDir: string, body: unknown) {
  const req = makeMockReq({ method: 'PATCH', url: '/api/status', body });
  const { res, result } = makeMockRes();
  await handleStatus(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    sessionsDir,
  );
  return result();
}

describe('handleStatus — phase-frontmatter', () => {
  let temp: ReturnType<typeof makeTempDir>;

  afterEach(() => temp?.cleanup());

  it('replaces status without disturbing other keys', async () => {
    const initial = '---\ntitle: My Phase\nstatus: draft\norder: 1\n---\n\n# Body\n';
    temp = makeTempDir({ 'sess/phases/01-core/spec.mdx': initial });

    const r = await callStatus(temp.dir, {
      kind: 'phase-frontmatter',
      file: 'sess/phases/01-core/spec.mdx',
      newStatus: 'in-progress',
    });

    expect(r.statusCode).toBe(200);
    const updated = readFileSync(join(temp.dir, 'sess/phases/01-core/spec.mdx'), 'utf8');
    expect(updated).toContain('status: in-progress');
    expect(updated).toContain('title: My Phase');
    expect(updated).toContain('order: 1');
    expect(updated).not.toContain('status: draft');
  });

  it('inserts status when absent from frontmatter', async () => {
    const initial = '---\ntitle: No Status\norder: 2\n---\n\n# Body\n';
    temp = makeTempDir({ 'sess/spec.mdx': initial });

    const r = await callStatus(temp.dir, {
      kind: 'phase-frontmatter',
      file: 'sess/spec.mdx',
      newStatus: 'proposed',
    });

    expect(r.statusCode).toBe(200);
    const updated = readFileSync(join(temp.dir, 'sess/spec.mdx'), 'utf8');
    expect(updated).toContain('status: proposed');
  });

  it('returns 404 for missing file', async () => {
    temp = makeTempDir({});
    const r = await callStatus(temp.dir, {
      kind: 'phase-frontmatter',
      file: 'nope/spec.mdx',
      newStatus: 'draft',
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('handleStatus — inline-status', () => {
  let temp: ReturnType<typeof makeTempDir>;

  afterEach(() => temp?.cleanup());

  it('rewrites value attribute and leaves siblings untouched', async () => {
    const line = '<Status value="draft" note="pending" />';
    const content = `line 1\n${line}\nline 3\n`;
    temp = makeTempDir({ 'sess/spec.mdx': content });

    const r = await callStatus(temp.dir, {
      kind: 'inline-status',
      file: 'sess/spec.mdx',
      sourceStart: { line: 2, col: 0 },
      sourceEnd: { line: 2, col: line.length },
      expectedText: line,
      newStatus: 'in-progress',
    });

    expect(r.statusCode).toBe(200);
    const updated = readFileSync(join(temp.dir, 'sess/spec.mdx'), 'utf8');
    expect(updated).toContain('<Status value="in-progress" note="pending" />');
    expect(updated).not.toContain('<Status value="draft"');
  });

  it('returns 409 on stale expectedText', async () => {
    const content = '<Status value="draft" />\n';
    temp = makeTempDir({ 'sess/spec.mdx': content });

    const r = await callStatus(temp.dir, {
      kind: 'inline-status',
      file: 'sess/spec.mdx',
      sourceStart: { line: 1, col: 0 },
      sourceEnd: { line: 1, col: 10 },
      expectedText: 'WRONG TEXT',
      newStatus: 'done',
    });

    expect(r.statusCode).toBe(409);
  });
});
