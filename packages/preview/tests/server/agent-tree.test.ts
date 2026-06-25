import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleAgentTreePut } from '../../src/server/agent-tree.js';

function session(content: string) {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'synergy-sessions-'));
  mkdirSync(join(sessionsDir, 'demo'), { recursive: true });
  writeFileSync(join(sessionsDir, 'demo', '00-plan.mdx'), content);
  return sessionsDir;
}

const SRC = `# Plan

<AgentTree nodes={[{ name: 'root', type: 'orchestrator', model: 'opus', effort: 'high' }]} />
`;

describe('handleAgentTreePut', () => {
  it('rewrites the nodes attribute and the new tree round-trips', async () => {
    const sessionsDir = session(SRC);
    const res = await handleAgentTreePut(sessionsDir, {
      file: 'demo/00-plan.mdx',
      tree: [{ name: 'root', type: 'orchestrator', model: 'sonnet', effort: 'max' }],
    });
    expect(res.ok).toBe(true);
    const out = readFileSync(join(sessionsDir, 'demo', '00-plan.mdx'), 'utf8');
    expect(out).toContain("model: 'sonnet'");
    expect(out).toContain("effort: 'max'");
    expect(out).toContain('# Plan'); // surrounding content preserved
  });

  it('returns not_found for a missing file', async () => {
    const sessionsDir = session(SRC);
    const res = await handleAgentTreePut(sessionsDir, { file: 'demo/nope.mdx', tree: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not_found');
  });

  it('returns no_agent_tree when the file has no AgentTree', async () => {
    const sessionsDir = session('# Plain\n\nNo tree here.\n');
    const res = await handleAgentTreePut(sessionsDir, { file: 'demo/00-plan.mdx', tree: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no_agent_tree');
  });
});
