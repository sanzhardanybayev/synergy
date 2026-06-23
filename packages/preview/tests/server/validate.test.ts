import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runValidate } from '../../src/server/validate.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'synergy-val-'));
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

describe('runValidate', () => {
  it('reports a clean session with zero errors', () => {
    const sessionDir = join(projectRoot, '.synergy', 'sessions', '2026-06-24-x');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, '00-overview.mdx'),
      '---\ntitle: X\ntype: feature\n---\n\n# Summary\n\nhi\n\n# Goals\n\n- g\n',
      'utf8',
    );
    const report = runValidate(projectRoot, '2026-06-24-x');
    expect(report.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(report.sessionsChecked).toBe(1);
  });
});
