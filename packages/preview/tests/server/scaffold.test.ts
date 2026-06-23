import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyScaffold } from '../../src/server/scaffold.js';

let sessionsDir: string;
const SESSION = '2026-06-24-demo';

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'synergy-scaffold-'));
});
afterEach(() => rmSync(sessionsDir, { recursive: true, force: true }));

describe('applyScaffold', () => {
  it('creates dirs and writes files relative to the session, creating parents', () => {
    const out = applyScaffold(sessionsDir, {
      session: SESSION,
      dirs: ['_components', 'assets'],
      files: [
        { path: '00-overview.mdx', content: '# Summary\n' },
        { path: 'phases/01-core/spec.mdx', content: '# Core\n' },
      ],
    });
    expect(out.written).toEqual(['00-overview.mdx', 'phases/01-core/spec.mdx']);
    expect(existsSync(join(sessionsDir, SESSION, '_components'))).toBe(true);
    expect(readFileSync(join(sessionsDir, SESSION, 'phases/01-core/spec.mdx'), 'utf8')).toBe(
      '# Core\n',
    );
  });

  it('rejects a file path that escapes the session dir', () => {
    expect(() =>
      applyScaffold(sessionsDir, {
        session: SESSION,
        files: [{ path: '../evil.txt', content: 'x' }],
      }),
    ).toThrow(/escapes/);
  });

  it('rejects an unsafe session name', () => {
    expect(() => applyScaffold(sessionsDir, { session: '../x', files: [] })).toThrow();
  });
});
