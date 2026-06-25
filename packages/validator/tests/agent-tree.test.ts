import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validate } from '../src/validate.js';

function scaffold(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'synergy-val-'));
  const dir = join(root, '.synergy', 'sessions', 'demo');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return root;
}

const messages = (root: string) => validate({ projectRoot: root }).issues.map((i) => i.message);

describe('AgentTree validation', () => {
  it('warns when a node has no resolvable effort', () => {
    const root = scaffold({
      '00-plan.mdx': `# Plan
<AgentTree nodes={[{ name: 'solo', type: 'sub-agent', model: 'opus' }]} />
`,
    });
    expect(messages(root).some((m) => /solo.*no effort/i.test(m))).toBe(true);
  });

  it('does NOT warn when effort is inherited from an ancestor', () => {
    const root = scaffold({
      '00-plan.mdx': `# Plan
<AgentTree nodes={[{ name: 'root', type: 'orchestrator', model: 'opus', effort: 'high', subAgents: [{ name: 'child', type: 'sub-agent', model: 'sonnet' }] }]} />
`,
    });
    expect(messages(root).some((m) => /child.*no effort/i.test(m))).toBe(false);
  });

  it('warns when a node has no model', () => {
    const root = scaffold({
      '00-plan.mdx': `# Plan
<AgentTree nodes={[{ name: 'solo', type: 'sub-agent', effort: 'high' }]} />
`,
    });
    expect(messages(root).some((m) => /solo.*no model/i.test(m))).toBe(true);
  });

  it('warns when a Phase references an unknown agent name', () => {
    const root = scaffold({
      '00-plan.mdx': `# Plan
<AgentTree nodes={[{ name: 'impl', type: 'sub-agent', model: 'opus', effort: 'high' }]} />
<Phase number={1} title="Build" id="build" agents={['ghost']} />
`,
    });
    expect(messages(root).some((m) => /unknown agent.*ghost/i.test(m))).toBe(true);
  });

  it('resolves cross-file agent references (no false warning)', () => {
    const root = scaffold({
      '00-tree.mdx': `# Tree
<AgentTree nodes={[{ name: 'impl', type: 'sub-agent', model: 'opus', effort: 'high' }]} />
`,
      '01-phases.mdx': `# Phases
<Phase number={1} title="Build" id="build" agents={['impl']} />
`,
    });
    expect(messages(root).some((m) => /unknown agent/i.test(m))).toBe(false);
  });

  it('warns with empty hint when no AgentTree exists', () => {
    const root = scaffold({
      '00-phases.mdx': `# Phases
<Phase number={1} title="Build" id="build" agents={['ghost']} />
`,
    });
    expect(messages(root).some((m) => /unknown agent.*ghost/i.test(m))).toBe(true);
  });
});
