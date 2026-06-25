// packages/spec-kit/tests/agent-tree-schema.test.ts
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { componentNames, schemas } from '../src/schemas-index.js';

describe('AgentTree schema', () => {
  it('is registered', () => {
    expect(componentNames).toContain('AgentTree');
  });

  it('accepts a nested tree and rejects an unknown field', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schemas.AgentTree as object);
    expect(
      validate({
        nodes: [
          {
            name: 'orchestrator',
            type: 'orchestrator',
            model: 'opus',
            effort: 'high',
            subAgents: [{ name: 'impl', type: 'sub-agent', model: 'sonnet' }],
          },
        ],
      }),
    ).toBe(true);
    expect(validate({ nodes: [{ name: 'x', type: 'sub-agent', bogus: 1 }] })).toBe(false);
  });
});
