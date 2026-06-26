import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const hook = fileURLToPath(new URL('../../../hooks/session-start.sh', import.meta.url));
let plugins: string;

function makeCache(versions: string[]) {
  for (const v of versions)
    mkdirSync(join(plugins, 'cache/synergy/synergy', v), { recursive: true });
}
function runHook(mineVersion: string): string {
  const root = join(plugins, 'cache/synergy/synergy', mineVersion);
  return execFileSync('bash', [hook], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_PLUGINS_DIR: plugins,
      SYNERGY_SKIP_UPSTREAM: '1',
    },
  });
}

beforeEach(() => {
  plugins = mkdtempSync(join(tmpdir(), 'synplugins-'));
});
afterEach(() => rmSync(plugins, { recursive: true, force: true }));

describe('session-start hook', () => {
  it('warns when a newer version is installed', () => {
    makeCache(['0.5.0', '0.6.0']);
    expect(runHook('0.5.0')).toContain('Restart Claude Code');
  });
  it('is silent when running the newest', () => {
    makeCache(['0.5.0', '0.6.0']);
    expect(runHook('0.6.0').trim()).toBe('');
  });
});
