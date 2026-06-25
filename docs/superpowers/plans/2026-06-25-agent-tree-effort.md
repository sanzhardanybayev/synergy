# Agent Tree + Quality-First Effort/Model Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `<AgentTree>` component that is the single source of truth for the agent hierarchy + per-node model/effort (effort inherits, model is per-node), editable in the preview with Save-to-MDX, slim `<AgentAllocation>` to phase ownership, and teach the authoring skills a quality-first model/effort rubric.

**Architecture:** Spec-kit gains a presentational `<AgentTree>` component plus pure tree utilities (flatten + effort-inheritance resolution). The validator warns on unresolvable effort/missing model and on phases referencing unknown agent names. The preview registers the component, wires per-node effort/model dropdowns through the existing EditBuffer, and a new `PUT /api/agent-tree` endpoint re-parses the MDX and rewrites the `<AgentTree>`'s `nodes` attribute. Authoring skills/templates teach the rubric and the mixed-effort team pattern.

**Tech Stack:** TypeScript (strict), React 18, MDX, Vite, `unified`/`remark-mdx`, `unist-util-visit`, AJV, Vitest + @testing-library/react, `ts-json-schema-generator`. pnpm workspaces.

## Global Constraints

- pnpm only (never npm/yarn). Run package scripts with `pnpm --filter <pkg> <script>`.
- TypeScript strict mode everywhere.
- Model enum stays `'opus' | 'sonnet' | 'haiku'`; effort enum stays `'low' | 'medium' | 'high' | 'max'`. Do not add values.
- One package per concern — do not let preview logic leak into spec-kit or vice versa. Spec-kit components are presentational; the preview injects `editable`/`onChange`/`dirty` props.
- Preview server stays on port 4321.
- Spec-kit JSON schemas are GENERATED, never hand-edited. After changing a Props type, run `pnpm --filter @synergy/spec-kit gen:schemas`.
- Cross-refs and agent references resolve by **slug/name**, never numeric prefix.
- Commit after every task with the message shown in its final step.

---

## File Structure

**Spec-kit (`packages/spec-kit`)**
- Create `src/components/AgentTree.tsx` — presentational tree component (props: `nodes`, `editable`, `dirty`, `onEffortChange`, `onModelChange`).
- Create `src/agent-tree.ts` — pure utilities: `flattenAgentTree`, `resolveNodeEffort`, `collectAgentNames`.
- Create `tests/AgentTree.test.tsx` and `tests/agent-tree.test.ts`.
- Modify `src/types.ts` — (no enum change; tree node types live in AgentTree.tsx for schema-gen).
- Modify `src/components/AgentAllocation.tsx` — drop `model`/`effort`/`count`; keep phase ownership.
- Modify `src/components/index.ts` — export `AgentTree`, its types, and `src/agent-tree.ts` utils.
- Modify `scripts/generate-schemas.ts` — register `AgentTree`.
- Modify `tests/AgentAllocation.test.tsx` — drop fan-out assertions.

**Validator (`packages/validator`)**
- Modify `src/validate.ts` — collect agent names from `<AgentTree>`; warn on unresolvable effort / missing model on executable nodes; warn on phase referencing an unknown agent name.
- Create `tests/agent-tree.test.ts` — coverage for the new warnings.

**Preview (`packages/preview`)**
- Create `src/AgentTreeView.tsx` — preview wrapper binding `<AgentTree>` to the EditBuffer.
- Modify `src/mdx-components.tsx` — register `AgentTree`.
- Modify `src/EditBuffer.types.ts` — add `AgentTreeEditEntry`.
- Modify `src/EditBuffer.tsx` — handle the new entry kind in `applyOne`.
- Modify `src/api.ts` — add `putAgentTree()`.
- Create `src/server/agent-tree.ts` — `PUT /api/agent-tree` handler (re-parse + rewrite `nodes`).
- Modify `src/server/vite-plugin-edit.ts` — route `PUT /api/agent-tree`.
- Create `src/server/agent-tree.test.ts`.

**Skills / templates / examples / docs**
- Modify `skills/create-spec/SKILL.md`, `skills/create-spec/templates/orchestrator-root.md`, `skills/create-spec/templates/phase/orchestrator.md`, `skills/spec-authoring/SKILL.md`, `skills/execute/SKILL.md`, `skills/resume/SKILL.md`.
- Modify `examples/.synergy/sessions/refactor-auth/02-implementation.mdx`.
- Modify `CLAUDE.md`.

---

## Task 1: Pure tree utilities (flatten + effort inheritance)

**Files:**
- Create: `packages/spec-kit/src/agent-tree.ts`
- Test: `packages/spec-kit/tests/agent-tree.test.ts`

**Interfaces:**
- Produces:
  - `interface AgentTreeNode { name: string; type: 'orchestrator' | 'sub-agent' | 'agent-team'; teamName?: string; responsibility?: string; model?: AgentModel; effort?: AgentEffort; count?: number; children?: AgentTreeNode[] }`
  - `interface FlatAgentNode { node: AgentTreeNode; depth: number; parentName: string | null; resolvedEffort: AgentEffort | null; resolvedModel: AgentModel | null }`
  - `function flattenAgentTree(nodes: AgentTreeNode[]): FlatAgentNode[]` — pre-order; `resolvedEffort` is the node's own `effort` or the nearest ancestor's; `resolvedModel` is the node's own `model` only (no inheritance) else `null`.
  - `function resolveNodeEffort(name: string, nodes: AgentTreeNode[]): AgentEffort | null`
  - `function collectAgentNames(nodes: AgentTreeNode[]): string[]` — every node name, pre-order.

- [ ] **Step 1: Write the failing test**

```ts
// packages/spec-kit/tests/agent-tree.test.ts
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
    children: [
      { name: 'storage-impl', type: 'sub-agent', model: 'sonnet' }, // inherits effort 'high'
      {
        name: 'migration-team',
        type: 'agent-team',
        teamName: 'Migration',
        effort: 'max',
        model: 'opus',
        children: [
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
      { name: 'a', type: 'orchestrator', model: 'opus', children: [{ name: 'b', type: 'sub-agent' }] },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/spec-kit exec vitest run tests/agent-tree.test.ts`
Expected: FAIL — cannot resolve `../src/agent-tree.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/spec-kit/src/agent-tree.ts
import type { AgentEffort, AgentModel } from './types.js';

export interface AgentTreeNode {
  name: string;
  type: 'orchestrator' | 'sub-agent' | 'agent-team';
  /** Display name for team nodes. */
  teamName?: string;
  responsibility?: string;
  /** Per-node model. Does NOT inherit. */
  model?: AgentModel;
  /** Effort; inherited from the nearest ancestor when absent. */
  effort?: AgentEffort;
  count?: number;
  children?: AgentTreeNode[];
}

export interface FlatAgentNode {
  node: AgentTreeNode;
  depth: number;
  parentName: string | null;
  resolvedEffort: AgentEffort | null;
  resolvedModel: AgentModel | null;
}

export function flattenAgentTree(nodes: AgentTreeNode[]): FlatAgentNode[] {
  const out: FlatAgentNode[] = [];
  const walk = (
    list: AgentTreeNode[],
    depth: number,
    parentName: string | null,
    inheritedEffort: AgentEffort | null,
  ) => {
    for (const node of list) {
      const resolvedEffort = node.effort ?? inheritedEffort;
      out.push({
        node,
        depth,
        parentName,
        resolvedEffort,
        resolvedModel: node.model ?? null,
      });
      if (node.children?.length) {
        walk(node.children, depth + 1, node.name, resolvedEffort);
      }
    }
  };
  walk(nodes, 0, null, null);
  return out;
}

export function resolveNodeEffort(name: string, nodes: AgentTreeNode[]): AgentEffort | null {
  const hit = flattenAgentTree(nodes).find((f) => f.node.name === name);
  return hit ? hit.resolvedEffort : null;
}

export function collectAgentNames(nodes: AgentTreeNode[]): string[] {
  return flattenAgentTree(nodes).map((f) => f.node.name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @synergy/spec-kit exec vitest run tests/agent-tree.test.ts`
Expected: PASS (all three describe blocks).

- [ ] **Step 5: Commit**

```bash
git add packages/spec-kit/src/agent-tree.ts packages/spec-kit/tests/agent-tree.test.ts
git commit -m "feat(spec-kit): agent tree flatten + effort-inheritance utilities"
```

---

## Task 2: `<AgentTree>` presentational component

**Files:**
- Create: `packages/spec-kit/src/components/AgentTree.tsx`
- Modify: `packages/spec-kit/src/components/index.ts`
- Test: `packages/spec-kit/tests/AgentTree.test.tsx`

**Interfaces:**
- Consumes: `AgentTreeNode`, `flattenAgentTree` from Task 1; `AgentModel`, `AgentEffort` from `types.ts`.
- Produces:
  - `interface AgentTreeProps { nodes: AgentTreeNode[]; context?: string; editable?: boolean; dirty?: boolean; onEffortChange?: (name: string, effort: AgentEffort | null) => void; onModelChange?: (name: string, model: AgentModel) => void; children?: ReactNode }`
  - `function AgentTree(props: AgentTreeProps): JSX.Element`
- Rendering contract: one row per flattened node, indented by `depth`. Shows `name` (and `teamName` for teams), type badge, resolved model, and resolved effort. When `editable`, model and effort render as `<select>` elements; effort options include `inherit` (value `""`) which calls `onEffortChange(name, null)`; a node whose effort is inherited shows the resolved value as the selected option with a `data-inherited="true"` marker. Each editable node row carries `data-agent-name={name}`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/spec-kit/tests/AgentTree.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentTree } from '../src/components/AgentTree.js';
import type { AgentTreeNode } from '../src/agent-tree.js';

const nodes: AgentTreeNode[] = [
  {
    name: 'orchestrator',
    type: 'orchestrator',
    effort: 'high',
    model: 'opus',
    children: [{ name: 'storage-impl', type: 'sub-agent', model: 'sonnet' }],
  },
];

describe('AgentTree', () => {
  it('renders a row per node with resolved effort/model', () => {
    render(<AgentTree nodes={nodes} />);
    expect(screen.getByText('orchestrator')).toBeTruthy();
    const row = screen.getByText('storage-impl').closest('[data-agent-name]') as HTMLElement;
    expect(row.getAttribute('data-agent-name')).toBe('storage-impl');
    // storage-impl inherits effort 'high', own model 'sonnet'
    expect(row.textContent).toContain('high');
    expect(row.textContent).toContain('sonnet');
  });

  it('emits onEffortChange with the selected value when editable', () => {
    const onEffortChange = vi.fn();
    render(<AgentTree nodes={nodes} editable onEffortChange={onEffortChange} />);
    const row = screen.getByText('storage-impl').closest('[data-agent-name]') as HTMLElement;
    const effortSelect = row.querySelector('select[data-field="effort"]') as HTMLSelectElement;
    fireEvent.change(effortSelect, { target: { value: 'max' } });
    expect(onEffortChange).toHaveBeenCalledWith('storage-impl', 'max');
  });

  it('emits onEffortChange(name, null) when set back to inherit', () => {
    const onEffortChange = vi.fn();
    render(<AgentTree nodes={nodes} editable onEffortChange={onEffortChange} />);
    const row = screen.getByText('storage-impl').closest('[data-agent-name]') as HTMLElement;
    const effortSelect = row.querySelector('select[data-field="effort"]') as HTMLSelectElement;
    fireEvent.change(effortSelect, { target: { value: '' } });
    expect(onEffortChange).toHaveBeenCalledWith('storage-impl', null);
  });

  it('emits onModelChange when editable', () => {
    const onModelChange = vi.fn();
    render(<AgentTree nodes={nodes} editable onModelChange={onModelChange} />);
    const row = screen.getByText('storage-impl').closest('[data-agent-name]') as HTMLElement;
    const modelSelect = row.querySelector('select[data-field="model"]') as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: 'haiku' } });
    expect(onModelChange).toHaveBeenCalledWith('storage-impl', 'haiku');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/spec-kit exec vitest run tests/AgentTree.test.tsx`
Expected: FAIL — cannot resolve `../src/components/AgentTree.js`.

- [ ] **Step 3: Write the implementation**

```tsx
// packages/spec-kit/src/components/AgentTree.tsx
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { type AgentTreeNode, flattenAgentTree } from '../agent-tree.js';
import type { AgentEffort, AgentModel } from '../types.js';

const MODELS: AgentModel[] = ['opus', 'sonnet', 'haiku'];
const EFFORTS: AgentEffort[] = ['low', 'medium', 'high', 'max'];

const typeLabel: Record<AgentTreeNode['type'], string> = {
  orchestrator: 'Orchestrator',
  'sub-agent': 'Sub-agent',
  'agent-team': 'Team',
};

export interface AgentTreeProps {
  nodes: AgentTreeNode[];
  context?: string;
  editable?: boolean;
  dirty?: boolean;
  /** effort === null means "clear override, inherit from ancestor". */
  onEffortChange?: (name: string, effort: AgentEffort | null) => void;
  onModelChange?: (name: string, model: AgentModel) => void;
  children?: ReactNode;
}

export function AgentTree({
  nodes,
  context,
  editable = false,
  dirty = false,
  onEffortChange,
  onModelChange,
  children,
}: AgentTreeProps) {
  const flat = flattenAgentTree(nodes);
  return (
    <div className={clsx('sk-agent-tree', dirty && 'sk-agent-tree--dirty')}>
      {context ? <p className="sk-agent-tree__context">{context}</p> : null}
      {dirty ? <span className="sk-agent-tree__pending" aria-label="unsaved changes" /> : null}
      <ul className="sk-agent-tree__list">
        {flat.map(({ node, depth, resolvedEffort, resolvedModel }) => {
          const label = node.type === 'agent-team' ? (node.teamName ?? node.name) : node.name;
          const ownEffort = node.effort;
          return (
            <li
              key={node.name}
              data-agent-name={node.name}
              className="sk-agent-tree__row"
              style={{ paddingLeft: `${depth * 1.25}rem` }}
            >
              <span className="sk-agent-tree__name">{label}</span>
              {node.type === 'agent-team' && node.teamName ? (
                <span className="sk-agent-tree__agentname">{node.name}</span>
              ) : null}
              <span className={clsx('sk-agent-tree__type', `sk-agent-tree__type--${node.type}`)}>
                {typeLabel[node.type]}
              </span>

              {editable ? (
                <select
                  data-field="model"
                  className="sk-agent-tree__select"
                  value={resolvedModel ?? ''}
                  onChange={(e) => onModelChange?.(node.name, e.target.value as AgentModel)}
                >
                  <option value="" disabled>
                    model…
                  </option>
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="sk-agent-tree__model">{resolvedModel ?? '—'}</span>
              )}

              {editable ? (
                <select
                  data-field="effort"
                  data-inherited={ownEffort === undefined ? 'true' : 'false'}
                  className="sk-agent-tree__select"
                  value={ownEffort ?? ''}
                  onChange={(e) =>
                    onEffortChange?.(node.name, e.target.value === '' ? null : (e.target.value as AgentEffort))
                  }
                >
                  <option value="">
                    inherit{resolvedEffort ? ` (${resolvedEffort})` : ''}
                  </option>
                  {EFFORTS.map((ef) => (
                    <option key={ef} value={ef}>
                      {ef}
                    </option>
                  ))}
                </select>
              ) : (
                <span
                  className="sk-agent-tree__effort"
                  data-inherited={ownEffort === undefined ? 'true' : 'false'}
                >
                  {resolvedEffort ?? '—'}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Export from the component index**

Modify `packages/spec-kit/src/components/index.ts` — add after the `AgentAllocation` exports (currently lines 11-12):

```ts
export { AgentTree } from './AgentTree.js';
export type { AgentTreeProps } from './AgentTree.js';
export { flattenAgentTree, resolveNodeEffort, collectAgentNames } from '../agent-tree.js';
export type { AgentTreeNode, FlatAgentNode } from '../agent-tree.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @synergy/spec-kit exec vitest run tests/AgentTree.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/spec-kit/src/components/AgentTree.tsx packages/spec-kit/src/components/index.ts packages/spec-kit/tests/AgentTree.test.tsx
git commit -m "feat(spec-kit): AgentTree presentational component with editable effort/model"
```

---

## Task 3: Generate the AgentTree JSON schema

**Files:**
- Modify: `packages/spec-kit/scripts/generate-schemas.ts:17-34` (the `components` array)
- Generated (do not hand-write): `packages/spec-kit/schemas/AgentTree.schema.json`, `packages/spec-kit/src/schemas-index.ts`

**Interfaces:**
- Consumes: `AgentTreeProps` from Task 2.
- Produces: a new `ComponentName` `'AgentTree'` available to the validator via `@synergy/spec-kit`.

- [ ] **Step 1: Register the component in the generator**

In `packages/spec-kit/scripts/generate-schemas.ts`, add to the `components` array (after the `Chart` entry at line 33):

```ts
  { name: 'AgentTree', file: 'src/components/AgentTree.tsx', type: 'AgentTreeProps' },
```

- [ ] **Step 2: Run schema generation**

Run: `pnpm --filter @synergy/spec-kit gen:schemas`
Expected: console prints `✓ AgentTree -> …/schemas/AgentTree.schema.json` and `✓ schemas-index.ts written`.

- [ ] **Step 3: Write a test asserting the schema is wired and validates a good tree**

```ts
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
            children: [{ name: 'impl', type: 'sub-agent', model: 'sonnet' }],
          },
        ],
      }),
    ).toBe(true);
    expect(validate({ nodes: [{ name: 'x', type: 'sub-agent', bogus: 1 }] })).toBe(false);
  });
});
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @synergy/spec-kit exec vitest run tests/agent-tree-schema.test.ts`
Expected: PASS. (If the nested `children` recursion fails to validate, confirm `generate-schemas.ts`'s `stripChildrenAndPrune` did not strip the `children` of `AgentTreeNode` — note that the helper deletes a property literally named `children`. See Step 5.)

- [ ] **Step 5: If the nested `children` were stripped, rename the field to `subAgents`**

`stripChildrenAndPrune` deletes any property named `children` (to drop React's `children`). Our tree's recursion uses `children`, which collides. If Step 4 fails because `children`/`subAgents` is missing from the generated schema, rename the recursion field from `children` to `subAgents` across `src/agent-tree.ts`, `src/components/AgentTree.tsx`, and the Task 1/2 tests (`node.children` → `node.subAgents`), re-run `gen:schemas`, and re-run all spec-kit tests. Keep the rename consistent everywhere.

> Implementer note: prefer to do Step 5 proactively — name the recursion field `subAgents` from the start in Tasks 1-2 to avoid the collision. If you already used `subAgents`, this step is a no-op and Step 4 passes directly.

- [ ] **Step 6: Commit**

```bash
git add packages/spec-kit/scripts/generate-schemas.ts packages/spec-kit/schemas/AgentTree.schema.json packages/spec-kit/src/schemas-index.ts packages/spec-kit/tests/agent-tree-schema.test.ts
git commit -m "feat(spec-kit): generate + wire AgentTree JSON schema"
```

---

## Task 4: Slim `<AgentAllocation>` to phase ownership

**Files:**
- Modify: `packages/spec-kit/src/components/AgentAllocation.tsx`
- Modify: `packages/spec-kit/tests/AgentAllocation.test.tsx`
- Regenerate: `packages/spec-kit/schemas/AgentAllocation.schema.json` (via `gen:schemas`)

**Interfaces:**
- Produces: `interface AgentAllocationEntry { name: string; type: AgentType; responsibility: string; phases?: (number | string)[] }` (drops `model`, `effort`, `count`). The "Fan-out" column and `fanout()` helper are removed.

- [ ] **Step 1: Update the failing test to the new contract**

Replace the body of `packages/spec-kit/tests/AgentAllocation.test.tsx` with:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentAllocation } from '../src/components/AgentAllocation.js';

describe('AgentAllocation', () => {
  it('renders name, type, responsibility, and phases — no fan-out column', () => {
    render(
      <AgentAllocation
        entries={[
          {
            name: 'storage-impl',
            type: 'sub-agent',
            responsibility: 'Implement TokenStore',
            phases: ['storage'],
          },
        ]}
      />,
    );
    expect(screen.getByText('storage-impl')).toBeTruthy();
    expect(screen.getByText('Implement TokenStore')).toBeTruthy();
    expect(screen.getByText('storage')).toBeTruthy();
    expect(screen.queryByText(/Fan-out/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/spec-kit exec vitest run tests/AgentAllocation.test.tsx`
Expected: FAIL — "Fan-out" header still present.

- [ ] **Step 3: Slim the component**

Replace `packages/spec-kit/src/components/AgentAllocation.tsx` with:

```tsx
import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { AgentType } from '../types.js';

export interface AgentAllocationEntry {
  name: string;
  type: AgentType;
  responsibility: string;
  /** Phases this agent touches — slugs (preferred) or legacy numbers. */
  phases?: (number | string)[];
}

export interface AgentAllocationProps {
  context?: string;
  entries: AgentAllocationEntry[];
  children?: ReactNode;
}

const typeLabel: Record<AgentType, string> = {
  'sub-agent': 'Sub-agent',
  'agent-team': 'Agent team',
  human: 'Human',
};

export function AgentAllocation({ context, entries, children }: AgentAllocationProps) {
  return (
    <div className="sk-allocation">
      {context ? <p className="sk-allocation__context">{context}</p> : null}
      <table className="sk-allocation__table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Type</th>
            <th>Responsibility</th>
            <th>Phases</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={`${e.name}-${i}`}>
              <td>
                <strong>{e.name}</strong>
              </td>
              <td>
                <span className={clsx('sk-allocation__type', `sk-allocation__type--${e.type}`)}>
                  {typeLabel[e.type]}
                </span>
              </td>
              <td>{e.responsibility}</td>
              <td>{e.phases?.length ? e.phases.join(', ') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Regenerate the schema and run tests**

Run: `pnpm --filter @synergy/spec-kit gen:schemas`
Then: `pnpm --filter @synergy/spec-kit exec vitest run tests/AgentAllocation.test.tsx`
Expected: schema regenerates without `model`/`effort`/`count`; test PASSES.

- [ ] **Step 5: Run the full spec-kit test suite + typecheck**

Run: `pnpm --filter @synergy/spec-kit test && pnpm --filter @synergy/spec-kit typecheck`
Expected: all green. (Confirms nothing else imported the removed fields.)

- [ ] **Step 6: Commit**

```bash
git add packages/spec-kit/src/components/AgentAllocation.tsx packages/spec-kit/tests/AgentAllocation.test.tsx packages/spec-kit/schemas/AgentAllocation.schema.json packages/spec-kit/src/schemas-index.ts
git commit -m "refactor(spec-kit): slim AgentAllocation to phase ownership (effort/model move to AgentTree)"
```

---

## Task 5: Validator warnings for the tree

**Files:**
- Modify: `packages/validator/src/validate.ts`
- Test: `packages/validator/tests/agent-tree.test.ts` (create)

**Interfaces:**
- Consumes: `flattenAgentTree`, `collectAgentNames`, `AgentTreeNode` from `@synergy/spec-kit`; the existing per-component iteration in `validateSession()` (warning push pattern at the `Phase`-missing-`id` block).
- Produces: three new warnings, all `severity: 'warning'`:
  1. An executable tree node (`type !== 'human'`; tree has no human type, so all nodes) with no resolvable effort → "Agent `<name>` has no effort and no ancestor effort to inherit — add an effort or set one on a parent."
  2. A tree node with no resolvable model → "Agent `<name>` has no model — assign one (start at opus; downgrade only when bounded + verified)."
  3. A `<Phase>` whose `agents` attribute references a name absent from the session's `<AgentTree>` → "Phase references unknown agent `<name>` — not present in any AgentTree (known agents: …)."

> Note: warning (3) assumes `<Phase agents={[...]}>` is the by-name reference. If `<Phase>` does not yet carry `agents`, this warning is still implemented but only fires once specs add the attribute; no schema change to `Phase` is required for a warning-only check because the validator reads `comp.attributes.agents` defensively.

- [ ] **Step 1: Write the failing test**

```ts
// packages/validator/tests/agent-tree.test.ts
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

const messages = (root: string) =>
  validate({ projectRoot: root }).issues.map((i) => i.message);

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
<AgentTree nodes={[{ name: 'root', type: 'orchestrator', model: 'opus', effort: 'high', children: [{ name: 'child', type: 'sub-agent', model: 'sonnet' }] }]} />
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/validator exec vitest run tests/agent-tree.test.ts`
Expected: FAIL — warnings not emitted.

- [ ] **Step 3: Implement the checks in `validateSession`**

In `packages/validator/src/validate.ts`:

(a) Add to the imports from `@synergy/spec-kit` (the existing import currently brings in `componentNames`, `schemas`, `ComponentName`):

```ts
import {
  type AgentTreeNode,
  type ComponentName,
  collectAgentNames,
  componentNames,
  flattenAgentTree,
  schemas,
} from '@synergy/spec-kit';
```

(b) Inside `validateSession()`, BEFORE the per-component loop, build the session-wide set of agent names by scanning every parsed spec's components for `AgentTree`:

```ts
const knownAgentNames = new Set<string>();
for (const spec of specs) {
  for (const comp of spec.components) {
    if (comp.name === 'AgentTree' && Array.isArray(comp.attributes.nodes)) {
      for (const n of collectAgentNames(comp.attributes.nodes as AgentTreeNode[])) {
        knownAgentNames.add(n);
      }
    }
  }
}
```

> `specs` is the array of parsed specs already iterated in `validateSession`. If the local variable has a different name (e.g. `parsedSpecs`), use that name — match the existing loop that pushes CrossRef/Phase issues.

(c) Inside the existing per-component loop (where the `Phase`-missing-`id` warning lives), add two branches:

```ts
if (comp.name === 'AgentTree' && Array.isArray(comp.attributes.nodes)) {
  for (const flat of flattenAgentTree(comp.attributes.nodes as AgentTreeNode[])) {
    if (flat.resolvedEffort === null) {
      issues.push({
        file: spec.filePath,
        line: comp.line,
        column: comp.column,
        component: 'AgentTree',
        severity: 'warning',
        message: `Agent \`${flat.node.name}\` has no effort and no ancestor effort to inherit — add an effort or set one on a parent.`,
      });
    }
    if (flat.resolvedModel === null) {
      issues.push({
        file: spec.filePath,
        line: comp.line,
        column: comp.column,
        component: 'AgentTree',
        severity: 'warning',
        message: `Agent \`${flat.node.name}\` has no model — assign one (start at opus; downgrade only when bounded + verified).`,
      });
    }
  }
}

if (comp.name === 'Phase' && Array.isArray(comp.attributes.agents)) {
  for (const ref of comp.attributes.agents as unknown[]) {
    if (typeof ref === 'string' && !knownAgentNames.has(ref)) {
      const known = [...knownAgentNames];
      const hint = known.length ? ` (known agents: ${known.join(', ')})` : '';
      issues.push({
        file: spec.filePath,
        line: comp.line,
        column: comp.column,
        component: 'Phase',
        severity: 'warning',
        message: `Phase references unknown agent \`${ref}\`${hint}.`,
      });
    }
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @synergy/validator exec vitest run tests/agent-tree.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full validator suite**

Run: `pnpm --filter @synergy/validator test`
Expected: all green (no regressions in cross-ref/phase tests).

- [ ] **Step 6: Commit**

```bash
git add packages/validator/src/validate.ts packages/validator/tests/agent-tree.test.ts
git commit -m "feat(validator): warn on unresolvable effort/model and unknown agent refs"
```

---

## Task 6: Preview — render + edit the tree through the EditBuffer

**Files:**
- Create: `packages/preview/src/AgentTreeView.tsx`
- Modify: `packages/preview/src/mdx-components.tsx`
- Modify: `packages/preview/src/EditBuffer.types.ts`
- Modify: `packages/preview/src/EditBuffer.tsx`
- Modify: `packages/preview/src/api.ts`
- Test: `packages/preview/src/AgentTreeView.test.tsx` (create)

**Interfaces:**
- Consumes: `AgentTree`, `AgentTreeNode` from `@synergy/spec-kit`; the EditBuffer context (`setDirty*`, `entries`, `applyOne`, `discard`); `currentFile`/`fileSource` from the buffer; `putAgentTree()` from Task 7's `api.ts` addition (declared here, implemented in Task 7).
- Produces:
  - `AgentTreeEditEntry` (in EditBuffer.types.ts): `{ kind: 'agent-tree'; file: string; originalTree: AgentTreeNode[]; currentTree: AgentTreeNode[] }` keyed `agent-tree:${file}`.
  - `AgentTreeView` preview wrapper: reads the buffer's current tree (or the authored `nodes`), applies edits immutably by node name, renders `<AgentTree editable …>` with Save/Discard buttons.

- [ ] **Step 1: Add the buffer entry type**

In `packages/preview/src/EditBuffer.types.ts`, add alongside `ProseEditEntry`/`StatusEditEntry`:

```ts
import type { AgentTreeNode } from '@synergy/spec-kit';

export interface AgentTreeEditEntry {
  readonly kind: 'agent-tree';
  readonly file: string;
  readonly originalTree: AgentTreeNode[];
  currentTree: AgentTreeNode[];
}
```

Add `AgentTreeEditEntry` to the `BufferEntry` union type in the same file.

- [ ] **Step 2: Declare the API client function (implemented in Task 7)**

In `packages/preview/src/api.ts`, add:

```ts
import type { AgentTreeNode } from '@synergy/spec-kit';

export async function putAgentTree(body: {
  file: string;
  tree: AgentTreeNode[];
}): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }> {
  const res = await fetch('/api/agent-tree', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}
```

- [ ] **Step 3: Handle the entry in `applyOne`**

In `packages/preview/src/EditBuffer.tsx`, inside `applyOne`, add a branch mirroring the `status` branch:

```ts
if (entry.kind === 'agent-tree') {
  const result = await putAgentTree({ file: entry.file, tree: entry.currentTree });
  if (result.ok) {
    discard(key);
    return true;
  }
  // surface result.reason via the existing toast mechanism used by the prose/status branches
  return false;
}
```

Import `putAgentTree` from `./api.js` at the top of the file.

- [ ] **Step 4: Write the failing test for the view wrapper**

```tsx
// packages/preview/src/AgentTreeView.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTreeNode } from '@synergy/spec-kit';
import { AgentTreeView } from './AgentTreeView.js';
import { EditBufferProvider } from './EditBuffer.js';

const nodes: AgentTreeNode[] = [
  { name: 'root', type: 'orchestrator', model: 'opus', effort: 'high',
    children: [{ name: 'impl', type: 'sub-agent', model: 'sonnet' }] },
];

function renderInBuffer(ui: React.ReactNode) {
  return render(<EditBufferProvider initialFile="demo/00-plan.mdx">{ui}</EditBufferProvider>);
}

describe('AgentTreeView', () => {
  it('marks the tree dirty after an effort change', () => {
    renderInBuffer(<AgentTreeView nodes={nodes} file="demo/00-plan.mdx" />);
    const row = screen.getByText('impl').closest('[data-agent-name]') as HTMLElement;
    const effort = row.querySelector('select[data-field="effort"]') as HTMLSelectElement;
    fireEvent.change(effort, { target: { value: 'max' } });
    expect(screen.getByRole('button', { name: /save/i })).toBeTruthy();
  });
});
```

> If `EditBufferProvider` does not accept an `initialFile` prop, set the current file through whatever mechanism the existing `SpecPage` uses (the explorer found `setFileSource`/current-file setters in `EditBuffer.tsx`); adapt the test harness to that API rather than inventing a prop.

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @synergy/preview exec vitest run src/AgentTreeView.test.tsx`
Expected: FAIL — cannot resolve `./AgentTreeView.js`.

- [ ] **Step 6: Implement the view wrapper**

```tsx
// packages/preview/src/AgentTreeView.tsx
import { AgentTree, type AgentTreeNode } from '@synergy/spec-kit';
import { useMemo } from 'react';
import { useEditBuffer } from './EditBuffer.js';

function mapNodes(
  nodes: AgentTreeNode[],
  name: string,
  apply: (n: AgentTreeNode) => AgentTreeNode,
): AgentTreeNode[] {
  return nodes.map((n) => {
    const next = n.name === name ? apply(n) : n;
    return next.children ? { ...next, children: mapNodes(next.children, name, apply) } : next;
  });
}

export interface AgentTreeViewProps {
  nodes: AgentTreeNode[];
  /** sessionsDir-relative path of the MDX file holding this AgentTree. */
  file: string;
}

export function AgentTreeView({ nodes, file }: AgentTreeViewProps) {
  const buffer = useEditBuffer();
  const key = `agent-tree:${file}`;
  const entry = buffer.entries.get(key);
  const currentTree = (entry?.kind === 'agent-tree' ? entry.currentTree : nodes) as AgentTreeNode[];
  const dirty = entry?.kind === 'agent-tree';

  const setTree = useMemo(
    () => (next: AgentTreeNode[]) =>
      buffer.setDirtyAgentTree(key, {
        kind: 'agent-tree',
        file,
        originalTree: nodes,
        currentTree: next,
      }),
    [buffer, key, file, nodes],
  );

  return (
    <div className="sk-agent-tree-view">
      <AgentTree
        nodes={currentTree}
        editable
        dirty={dirty}
        onModelChange={(name, model) =>
          setTree(mapNodes(currentTree, name, (n) => ({ ...n, model })))
        }
        onEffortChange={(name, effort) =>
          setTree(
            mapNodes(currentTree, name, (n) => {
              const next = { ...n };
              if (effort === null) delete next.effort;
              else next.effort = effort;
              return next;
            }),
          )
        }
      />
      {dirty ? (
        <div className="sk-agent-tree-view__actions">
          <button type="button" onClick={() => buffer.applyOne(key)}>
            Save
          </button>
          <button type="button" onClick={() => buffer.discard(key)}>
            Discard
          </button>
        </div>
      ) : null}
    </div>
  );
}
```

> `buffer.setDirtyAgentTree` mirrors the existing `setDirtyStatus`. Add it to the EditBuffer context next to `setDirtyStatus` (same shape: `(key, entry) => setEntries(prev => new Map(prev).set(key, entry))`). Match the exact setter pattern already in `EditBuffer.tsx`.

- [ ] **Step 7: Register the component for MDX rendering**

In `packages/preview/src/mdx-components.tsx`, import and register. Because `AgentTreeView` needs the `file`, pass the current file from context. Add:

```tsx
import { AgentTreeView } from './AgentTreeView.js';
// ...inside mdxComponents:
  AgentTree: (props: { nodes: AgentTreeNode[] }) => <AgentTreeBound {...props} />,
```

Where `AgentTreeBound` reads the current file from the EditBuffer and forwards it:

```tsx
function AgentTreeBound(props: { nodes: AgentTreeNode[] }) {
  const buffer = useEditBuffer();
  return <AgentTreeView nodes={props.nodes} file={buffer.currentFile} />;
}
```

> Use whatever the buffer exposes as the current file (the explorer found `currentFile` set by `SpecPage`/`PhasePage`). If it is not on the context, thread it via the same provider value the prose `EditableBlock` uses.

- [ ] **Step 8: Run tests + typecheck**

Run: `pnpm --filter @synergy/preview exec vitest run src/AgentTreeView.test.tsx && pnpm --filter @synergy/preview typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/preview/src/AgentTreeView.tsx packages/preview/src/AgentTreeView.test.tsx packages/preview/src/mdx-components.tsx packages/preview/src/EditBuffer.tsx packages/preview/src/EditBuffer.types.ts packages/preview/src/api.ts
git commit -m "feat(preview): render + buffer-edit AgentTree effort/model with Save/Discard"
```

---

## Task 7: Preview server — `PUT /api/agent-tree` write-back

**Files:**
- Create: `packages/preview/src/server/agent-tree.ts`
- Modify: `packages/preview/src/server/vite-plugin-edit.ts`
- Test: `packages/preview/src/server/agent-tree.test.ts` (create)

**Interfaces:**
- Consumes: `resolveSessionsRelative` from `server/paths.ts`; the atomic write pattern (temp file + rename) used by `server/edit.ts`; `unified`/`remarkParse`/`remarkMdx` + `unist-util-visit` (already validator deps; add to preview if absent).
- Produces: `handleAgentTreePut(sessionsDir, body): { ok: true } | { ok: false; reason: 'not_found' | 'no_agent_tree' | 'error'; detail?: string }`. It re-parses the file, finds the single `mdxJsxFlowElement` named `AgentTree`, locates its `nodes` attribute's value source span via the AST `position`, replaces that span with `serializeTree(body.tree)`, and atomically writes.

- [ ] **Step 1: Write the failing test**

```ts
// packages/preview/src/server/agent-tree.test.ts
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleAgentTreePut } from './agent-tree.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @synergy/preview exec vitest run src/server/agent-tree.test.ts`
Expected: FAIL — cannot resolve `./agent-tree.js`.

- [ ] **Step 3: Implement the handler**

```ts
// packages/preview/src/server/agent-tree.ts
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { resolveSessionsRelative } from './paths.js';

export interface AgentTreeNodeLike {
  name: string;
  type: string;
  teamName?: string;
  responsibility?: string;
  model?: string;
  effort?: string;
  count?: number;
  children?: AgentTreeNodeLike[];
}

type Result =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'no_agent_tree' | 'error'; detail?: string };

/** Serialize a node to a single-quoted JS object literal (stable key order). */
function serializeNode(n: AgentTreeNodeLike): string {
  const parts: string[] = [`name: '${n.name}'`, `type: '${n.type}'`];
  if (n.teamName !== undefined) parts.push(`teamName: '${n.teamName}'`);
  if (n.responsibility !== undefined)
    parts.push(`responsibility: '${n.responsibility.replace(/'/g, "\\'")}'`);
  if (n.model !== undefined) parts.push(`model: '${n.model}'`);
  if (n.effort !== undefined) parts.push(`effort: '${n.effort}'`);
  if (n.count !== undefined) parts.push(`count: ${n.count}`);
  if (n.children?.length) parts.push(`children: ${serializeTree(n.children)}`);
  return `{ ${parts.join(', ')} }`;
}

export function serializeTree(nodes: AgentTreeNodeLike[]): string {
  return `[${nodes.map(serializeNode).join(', ')}]`;
}

export async function handleAgentTreePut(
  sessionsDir: string,
  body: { file: string; tree: AgentTreeNodeLike[] },
): Promise<Result> {
  let absPath: string;
  try {
    absPath = resolveSessionsRelative(sessionsDir, body.file);
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err) };
  }
  if (!existsSync(absPath)) return { ok: false, reason: 'not_found' };

  const source = readFileSync(absPath, 'utf8');
  const tree = unified().use(remarkParse).use(remarkMdx).parse(source);

  let attrStart: number | null = null;
  let attrEnd: number | null = null;
  visit(tree, 'mdxJsxFlowElement', (node: any) => {
    if (node.name !== 'AgentTree' || attrStart !== null) return;
    const attr = (node.attributes ?? []).find(
      (a: any) => a.type === 'mdxJsxAttribute' && a.name === 'nodes',
    );
    if (attr?.value?.type === 'mdxJsxAttributeValueExpression' && attr.value.position) {
      // position covers the expression text WITHOUT the surrounding braces.
      attrStart = attr.value.position.start.offset;
      attrEnd = attr.value.position.end.offset;
    }
  });

  if (attrStart === null || attrEnd === null) return { ok: false, reason: 'no_agent_tree' };

  const next = source.slice(0, attrStart) + serializeTree(body.tree) + source.slice(attrEnd);

  try {
    const tmp = join(dirname(absPath), `.agent-tree.${process.pid}.tmp`);
    writeFileSync(tmp, next, 'utf8');
    renameSync(tmp, absPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err) };
  }
}
```

> Verify the AST offset convention against the installed `remark-mdx`: the test in Step 1 asserts the surrounding `# Plan` survives and the new `model`/`effort` land inside the braces. If `attr.value.position` offsets include or exclude the braces differently than assumed, adjust `attrStart`/`attrEnd` by the brace width so the replaced span is exactly the bracketed expression (between `{` and `}`). The test is the oracle — make it green.

- [ ] **Step 4: Route the endpoint**

In `packages/preview/src/server/vite-plugin-edit.ts`, alongside the `PUT /api/edit` and `PATCH /api/status` routes, add:

```ts
if (req.method === 'PUT' && url.pathname === '/api/agent-tree') {
  const body = await readJsonBody(req); // use the existing body-reader helper in this file
  const result = await handleAgentTreePut(sessionsDir, body);
  res.setHeader('content-type', 'application/json');
  res.statusCode = result.ok ? 200 : result.reason === 'not_found' ? 404 : 409;
  res.end(JSON.stringify(result));
  return;
}
```

Import `handleAgentTreePut` at the top. Use the same `sessionsDir` and body-reading helper the existing routes use (match their exact names).

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @synergy/preview exec vitest run src/server/agent-tree.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Build the preview to confirm the plugin compiles**

Run: `pnpm --filter @synergy/preview build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/preview/src/server/agent-tree.ts packages/preview/src/server/agent-tree.test.ts packages/preview/src/server/vite-plugin-edit.ts
git commit -m "feat(preview): PUT /api/agent-tree rewrites the AgentTree nodes attribute"
```

---

## Task 8: Authoring rubric + tree guidance in skills & templates

**Files:**
- Modify: `skills/create-spec/SKILL.md`
- Modify: `skills/create-spec/templates/orchestrator-root.md`
- Modify: `skills/create-spec/templates/phase/orchestrator.md`
- Modify: `skills/spec-authoring/SKILL.md`
- Modify: `skills/execute/SKILL.md`
- Modify: `skills/resume/SKILL.md`

No unit tests; verification is content checks + an example validation in Task 9.

- [ ] **Step 1: Add the rubric + AgentTree authoring section to create-spec**

In `skills/create-spec/SKILL.md`, replace the single cheat-sheet line for `<AgentAllocation>` with a new subsection. Add this block where the component cheat sheet lives:

```markdown
### Agent structure: `<AgentTree>` + `<AgentAllocation>`

Author the agent roster as a tree — the single source of truth for the hierarchy
and for each agent's model/effort:

<AgentTree
  context="Orchestrator coordinates; implementors and teams hang beneath it."
  nodes={[
    { name: 'orchestrator', type: 'orchestrator', model: 'opus', effort: 'high', children: [
      { name: 'storage-impl', type: 'sub-agent', responsibility: 'Implement TokenStore', model: 'sonnet', effort: 'medium' },
      { name: 'migration', type: 'agent-team', teamName: 'Migration', model: 'opus', effort: 'max', children: [
        { name: 'scout', type: 'sub-agent', model: 'haiku', effort: 'low' },
        { name: 'verifier', type: 'sub-agent', model: 'opus' },
      ] },
    ] },
  ]}
/>

Then map agents to phases with the slimmed `<AgentAllocation>` (name + phases only —
NO model/effort here; those live in the tree). `<Phase>` references agents by name.

**Quality-first model/effort rubric — quality is the invariant, cost flexes underneath:**

> Start at `opus`. Drop a tier only when the task is *provably bounded* AND a
> *verification gate downstream would catch a miss*. When unsure, don't drop.

| Condition | Model / Effort |
|---|---|
| Any judgment, design, ambiguity, or risk (the default) | `opus` / `high`–`max` |
| Fully-specified implementation against a clear interface, **verified downstream** | `sonnet` / `medium` |
| Purely mechanical, zero-judgment, fully bounded, **verified downstream** | `haiku` / `low` |
| A verification / review node | never below the tier of the riskiest thing it checks |

Effort **inherits** down the tree (omit it to inherit the parent's); model is **per-node**
(does not inherit). Every executable node must resolve to a model + effort or the
validator warns.
```

- [ ] **Step 2: Add the mixed-effort team pattern to the root orchestrator template**

In `skills/create-spec/templates/orchestrator-root.md`, replace the "Agent strategy" bullet list (lines 26-34) with:

```markdown
## Agent strategy

- **Sub-agents (single-shot, isolated)** for: file-bounded implementation where the
  interface is already specified.
- **Agent team (multi-step, exploratory)** for: cross-cutting concerns, debugging,
  integration testing.
- **Mixed-effort teams** are the cost lever: pair cheap producers (e.g. a `haiku/low`
  scout that gathers and narrows) with one expensive reasoner/verifier (`opus/high`)
  that decides on the narrowed input. The cheap members are safe *because* the verifier
  downstream sets the quality floor.
- **Model/effort** for every agent is declared in the `<AgentTree>` (see the spec),
  following the quality-first rubric: start at opus, downgrade only when the task is
  provably bounded and verified downstream.
- **Human in the loop** at every phase boundary: present a diff, run tests, get approval.
```

- [ ] **Step 3: Mirror the guidance in the phase orchestrator template**

In `skills/create-spec/templates/phase/orchestrator.md`, replace the "Agent strategy" block (lines 19-24) with:

```markdown
## Agent strategy

- **Sub-agent** for: _bounded, well-specified tasks._
- **Agent team** for: _cross-cutting or exploratory work._
- **Mixed-effort team** for: _expensive reasoning gated by a cheap producer — name the
  cheap producer and the verifier; the verifier sets the quality floor._
- **Model/effort**: declared per agent in the `<AgentTree>`; this phase references agents
  by name only. Start at opus; downgrade only when bounded + verified downstream.
- **Human in the loop** at: _phase boundary; review before next phase starts._
```

- [ ] **Step 4: Add a one-line pointer in spec-authoring**

In `skills/spec-authoring/SKILL.md`, in the component-usage section, add:

```markdown
- Agent rosters use `<AgentTree>` (hierarchy + model/effort; effort inherits, model is
  per-node) as the source of truth; `<AgentAllocation>` maps agents to phases by name
  only. Never put model/effort on `<AgentAllocation>` or inline on `<Phase>`.
```

- [ ] **Step 5: Update execute + resume to resolve from the tree by name**

In `skills/execute/SKILL.md`, replace the fan-out step (lines 28-29) with:

```markdown
Fan out per the phase's agent references: each `<Phase>` names its agents; look those
names up in the session's `<AgentTree>` to get each agent's **model** and **effort**
(effort inherits from the nearest ancestor; model is per-node). Spawn the specified
`type` and `count` (count, if any, stays on the tree node) at that model/effort.
**Run-time directives override these for THIS run only — never rewrite the `<AgentTree>`.**
```

And in the "Don'ts" line about `<AgentAllocation>`, change it to reference `<AgentTree>`:

```markdown
Don't let a run directive ("use sonnet") mutate the stored `<AgentTree>` plan.
```

In `skills/resume/SKILL.md`, no structural change is needed (it defers to execute), but verify its hand-off line still reads "Apply any run-time directives the user passed." — leave as is.

- [ ] **Step 6: Verify the content edits**

Run:
```bash
grep -l "AgentTree" skills/create-spec/SKILL.md skills/create-spec/templates/orchestrator-root.md skills/create-spec/templates/phase/orchestrator.md skills/spec-authoring/SKILL.md skills/execute/SKILL.md
grep -c "quality-first\|Start at .opus\|provably bounded" skills/create-spec/SKILL.md
```
Expected: all five files listed; the rubric phrases present in create-spec.

- [ ] **Step 7: Commit**

```bash
git add skills/create-spec/SKILL.md skills/create-spec/templates/orchestrator-root.md skills/create-spec/templates/phase/orchestrator.md skills/spec-authoring/SKILL.md skills/execute/SKILL.md skills/resume/SKILL.md
git commit -m "docs(skills): quality-first model/effort rubric + AgentTree authoring + mixed-effort teams"
```

---

## Task 9: Migrate the example session + update CLAUDE.md

**Files:**
- Modify: `examples/.synergy/sessions/refactor-auth/02-implementation.mdx`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the slimmed `<AgentAllocation>` (Task 4) and `<AgentTree>` (Task 2).

- [ ] **Step 1: Replace the example's AgentAllocation with AgentTree + slimmed allocation**

In `examples/.synergy/sessions/refactor-auth/02-implementation.mdx`, replace the existing `<AgentAllocation ... model/effort/count ... />` block (around lines 34-46) with an `<AgentTree>` carrying the model/effort, plus a slimmed `<AgentAllocation>` for phase ownership:

```mdx
<AgentTree
  context="Phase 1 & 3 are bounded sub-agents. Phase 2 (live-traffic cutover) runs as an agent team with human-in-the-loop at every canary step."
  nodes={[
    { name: 'orchestrator', type: 'orchestrator', model: 'opus', effort: 'high', children: [
      { name: 'storage-impl', type: 'sub-agent', responsibility: 'Implement TokenStore + ComplianceStore', model: 'opus', effort: 'high' },
      { name: 'service-wiring', type: 'sub-agent', responsibility: 'Wire dual-write, instrumentation', model: 'opus', effort: 'high' },
      { name: 'migration-team', type: 'agent-team', teamName: 'Migration', responsibility: 'Read cutover + backfill, with canary supervision', model: 'opus', effort: 'max', children: [
        { name: 'audit-prep', type: 'sub-agent', responsibility: 'Compliance audit packet', model: 'sonnet', effort: 'medium' },
      ] },
    ] },
  ]}
/>

<AgentAllocation
  context="Who touches which phase."
  entries={[
    { name: 'storage-impl', type: 'sub-agent', responsibility: 'Implement TokenStore + ComplianceStore', phases: ['storage'] },
    { name: 'service-wiring', type: 'sub-agent', responsibility: 'Wire dual-write, instrumentation', phases: ['storage'] },
    { name: 'migration-team', type: 'agent-team', responsibility: 'Read cutover + backfill', phases: ['cutover'] },
    { name: 'audit-prep', type: 'sub-agent', responsibility: 'Compliance audit packet', phases: ['cleanup'] },
    { name: 'avery', type: 'human', responsibility: 'Approve each phase boundary', phases: ['storage', 'cutover', 'cleanup'] },
    { name: 'riya', type: 'human', responsibility: 'Compliance sign-off after Phase 3', phases: ['cleanup'] },
  ]}
/>
```

- [ ] **Step 2: Validate the example session**

Run: `pnpm --filter @synergy/cli build && node packages/cli/dist/cli.js validate --project-root examples 2>/dev/null || pnpm --filter @synergy/validator exec vitest run`
Then run the validator against the example directly (use the project's existing validate entry):
```bash
node -e "import('@synergy/validator').then(m => console.log(JSON.stringify(m.validate({ projectRoot: 'examples' }).issues, null, 2)))"
```
Expected: no `error`-severity issues for `refactor-auth`; any AgentTree warnings should be intentional (every node here has a resolvable model + inherited/own effort, so there should be none).

- [ ] **Step 3: Update CLAUDE.md**

In `CLAUDE.md`, under "Spec-kit usage rules" (and the execution-state section), add:

```markdown
- **Agent roster:** declare agents in `<AgentTree>` — the single source of truth for the
  hierarchy and per-agent model/effort. Effort **inherits** down the tree (omit to inherit
  the parent's); model is **per-node** (no inheritance). Apply the quality-first rubric:
  start at `opus`, drop a tier only when the task is provably bounded AND verified
  downstream. `<AgentAllocation>` is slimmed to agent→phase ownership (name + phases only,
  no model/effort/count). `<Phase>` references agents by name; look up effort in the tree.
  The preview lets you edit effort (inheriting) and model (per-node) and **Save** writes
  back into the `<AgentTree>` source.
```

- [ ] **Step 4: Full workspace check**

Run: `pnpm -r build && pnpm -r test`
Expected: every package builds and all tests pass.

- [ ] **Step 5: Commit**

```bash
git add examples/.synergy/sessions/refactor-auth/02-implementation.mdx CLAUDE.md
git commit -m "docs: migrate refactor-auth example to AgentTree + document the convention"
```

---

## Self-Review

**Spec coverage** (design §1–§7):
- §1 Rubric → Task 8 (create-spec, templates), Task 9 (CLAUDE.md). ✓
- §2 `<AgentTree>` component → Tasks 1 (utils), 2 (component), 3 (schema). ✓
- §3 Slim `<AgentAllocation>` → Task 4. ✓
- §4 Phases reference by name → Task 5 (validator check), Task 8 (execute reads by name), Task 9 (example). ✓
- §5 Editing + Save persistence → Task 6 (buffer + UI), Task 7 (write-back endpoint). ✓
- §6 Execution honors the tree → Task 8 (execute/resume edits). ✓
- §7 Validator additions → Task 5. ✓

**Placeholder scan:** No "TBD"/"handle edge cases" left. Trickier spots (schema `children` collision in Task 3 Step 5; AST offset convention in Task 7 Step 3; buffer current-file API in Task 6) carry explicit "the test is the oracle / adapt to existing names" notes rather than vague instructions, because the exact local identifiers must be confirmed against the live code during implementation.

**Type consistency:** `AgentTreeNode` shape is identical across Tasks 1, 2, 5, 6, 7 (server uses a structural `AgentTreeNodeLike`). `flattenAgentTree`/`collectAgentNames`/`resolveNodeEffort` signatures match between definition (Task 1) and use (Tasks 2, 5). `putAgentTree` is declared in Task 6 and consumed by `applyOne`, implemented server-side in Task 7. The `children` vs `subAgents` recursion-field decision is pinned in Task 3 Step 5 and must be applied consistently if triggered.

**Known assumption to confirm during execution:** the by-name phase→agent link uses a `<Phase agents={[...]}>` attribute. Task 5 implements the warning defensively (reads `comp.attributes.agents` if present); Task 8/9 wire specs to use it. If the team prefers a different attribute name than `agents`, change it in Task 5's check and Task 9's example together.
