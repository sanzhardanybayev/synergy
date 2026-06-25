import { describe, expect, it } from 'vitest';
import {
  type AgentTreeNode,
  collectAgentNames,
  flattenAgentTree,
  resolveNodeEffort,
} from '../src/agent-tree.js';

const tree: AgentTreeNode[] = [
  {
    name: 'orchestrator',
    type: 'orchestrator',
    effort: 'high',
    model: 'opus',
    subAgents: [
      { name: 'storage-impl', type: 'sub-agent', model: 'sonnet' }, // inherits effort 'high'
      {
        name: 'migration-team',
        type: 'agent-team',
        teamName: 'Migration',
        effort: 'max',
        model: 'opus',
        subAgents: [
          { name: 'scout', type: 'sub-agent', effort: 'low', model: 'haiku' },
          { name: 'verifier', type: 'sub-agent', model: 'opus' }, // inherits 'max'
        ],
      },
    ],
  },
];

describe('flattenAgentTree', () => {
  it('resolves effort by inheritance and model per-node only', () => {
    const flat = flattenAgentTree(tree);
    const byName = Object.fromEntries(flat.map((f) => [f.node.name, f]));

    expect(byName['storage-impl'].resolvedEffort).toBe('high'); // inherited
    expect(byName['storage-impl'].resolvedModel).toBe('sonnet'); // own
    expect(byName['verifier'].resolvedEffort).toBe('max'); // inherited from team
    expect(byName['verifier'].resolvedModel).toBe('opus'); // own
    expect(byName['scout'].resolvedEffort).toBe('low'); // own override
    expect(byName['migration-team'].depth).toBe(1);
    expect(byName['scout'].parentName).toBe('migration-team');
  });

  it('returns null resolvedModel when node has no own model', () => {
    const flat = flattenAgentTree([
      { name: 'a', type: 'orchestrator', model: 'opus', subAgents: [{ name: 'b', type: 'sub-agent' }] },
    ]);
    expect(flat.find((f) => f.node.name === 'b')!.resolvedModel).toBeNull();
  });

  it('returns null resolvedEffort when no ancestor has effort', () => {
    const flat = flattenAgentTree([{ name: 'a', type: 'sub-agent' }]);
    expect(flat[0].resolvedEffort).toBeNull();
  });
});

describe('resolveNodeEffort', () => {
  it('walks ancestors', () => {
    expect(resolveNodeEffort('verifier', tree)).toBe('max');
    expect(resolveNodeEffort('storage-impl', tree)).toBe('high');
    expect(resolveNodeEffort('missing', tree)).toBeNull();
  });
});

describe('collectAgentNames', () => {
  it('returns every node name pre-order', () => {
    expect(collectAgentNames(tree)).toEqual([
      'orchestrator',
      'storage-impl',
      'migration-team',
      'scout',
      'verifier',
    ]);
  });
});
