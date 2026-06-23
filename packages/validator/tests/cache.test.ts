import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearParseCache, parseSpecCached } from '../src/cache.js';

let dir: string;
const MDX = '---\ntitle: T\n---\n\n# Summary\n\ntext\n';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'synergy-cache-'));
  clearParseCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseSpecCached', () => {
  it('returns the same object instance on a second call when mtime is unchanged', () => {
    const f = join(dir, 'a.mdx');
    writeFileSync(f, MDX, 'utf8');
    const first = parseSpecCached(f);
    const second = parseSpecCached(f);
    expect(second).toBe(first); // identity → cache hit
  });

  it('re-parses when the file mtime changes', () => {
    const f = join(dir, 'a.mdx');
    writeFileSync(f, MDX, 'utf8');
    const first = parseSpecCached(f);
    // bump mtime forward 2s and rewrite
    writeFileSync(f, `${MDX}\n## Goals\n`, 'utf8');
    const future = new Date(Date.now() + 2000);
    utimesSync(f, future, future);
    const second = parseSpecCached(f);
    expect(second).not.toBe(first); // cache miss → fresh parse
  });

  it('clearParseCache forces a re-parse', () => {
    const f = join(dir, 'a.mdx');
    writeFileSync(f, MDX, 'utf8');
    const first = parseSpecCached(f);
    clearParseCache();
    const second = parseSpecCached(f);
    expect(second).not.toBe(first);
  });
});
