import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/version-sync.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'synguard-'));
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'skills/create-spec'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ version: '0.7.0' }));
  writeFileSync(
    join(root, '.claude-plugin/marketplace.json'),
    '{\n  "plugins": [\n    { "name": "synergy", "version": "0.6.0" }\n  ]\n}\n',
  );
  writeFileSync(
    join(root, 'skills/create-spec/SKILL.md'),
    '---\nname: create-spec\n---\n<!-- synergy-version: 0.6.0 -->\n\nbody\n',
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('version-sync', () => {
  it('--check reports drift with a non-zero code', () => {
    expect(run(['--check'], root)).toBe(1);
  });
  it('writes the plugin.json version into all derived files', () => {
    expect(run([], root)).toBe(0);
    expect(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8')).toContain(
      '"version": "0.7.0"',
    );
    expect(readFileSync(join(root, 'skills/create-spec/SKILL.md'), 'utf8')).toContain(
      'synergy-version: 0.7.0',
    );
    expect(run(['--check'], root)).toBe(0); // now consistent
  });
});
