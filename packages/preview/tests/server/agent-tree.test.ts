import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
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
    expect(out).toMatch(/nodes=\{\[.*\]\}/s);
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

  it('apostrophe round-trip: name and responsibility with apostrophes serialize safely and re-parse', async () => {
    const sessionsDir = session(SRC);
    const res = await handleAgentTreePut(sessionsDir, {
      file: 'demo/00-plan.mdx',
      tree: [
        {
          name: "avery's agent",
          type: 'orchestrator',
          responsibility: "audit's packet",
        },
      ],
    });
    expect(res.ok).toBe(true);
    const out = readFileSync(join(sessionsDir, 'demo', '00-plan.mdx'), 'utf8');
    // JSON.stringify produces double-quoted values with escaped internals
    expect(out).toContain('"avery\'s agent"');
    expect(out).toContain('"audit\'s packet"');
    // Re-parse must not throw
    expect(() => unified().use(remarkParse).use(remarkMdx).parse(out)).not.toThrow();
  });

  it('returns invalid for an unknown model enum value', async () => {
    const sessionsDir = session(SRC);
    const res = await handleAgentTreePut(sessionsDir, {
      file: 'demo/00-plan.mdx',
      tree: [{ name: 'root', type: 'orchestrator', model: 'gpt' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid');
  });

  it('returns invalid for a non-finite count', async () => {
    const sessionsDir = session(SRC);
    const res = await handleAgentTreePut(sessionsDir, {
      file: 'demo/00-plan.mdx',
      tree: [{ name: 'root', type: 'orchestrator', count: Number.POSITIVE_INFINITY }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid');
  });

  it('returns invalid when tree is not an array', async () => {
    const sessionsDir = session(SRC);
    const res = await handleAgentTreePut(sessionsDir, {
      file: 'demo/00-plan.mdx',
      tree: 'not-an-array',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid');
  });
});
