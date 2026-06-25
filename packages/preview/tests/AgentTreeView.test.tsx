/**
 * Tests for AgentTreeView — the EditBuffer-wired wrapper around AgentTree.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTreeNode } from '@synergy/spec-kit';
import { AgentTree } from '@synergy/spec-kit';
import { AgentTreeView } from '../src/AgentTreeView.js';
import { EditBufferProvider } from '../src/EditBuffer.js';
import { ToastProvider } from '../src/ToastProvider.js';

// ---------------------------------------------------------------------------
// Mock fetch (needed so applyOne does not explode)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <EditBufferProvider>{children}</EditBufferProvider>
    </ToastProvider>
  );
}

const nodes: AgentTreeNode[] = [
  {
    name: 'root',
    type: 'orchestrator',
    model: 'opus',
    effort: 'high',
    subAgents: [{ name: 'impl', type: 'sub-agent', model: 'sonnet' }],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentTreeView', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('marks the tree dirty after an effort change', () => {
    render(
      <Wrapper>
        <AgentTreeView nodes={nodes} file="demo/00-plan.mdx" />
      </Wrapper>,
    );

    const row = screen.getByText('impl').closest('[data-agent-name]') as HTMLElement;
    const effort = row.querySelector('select[data-field="effort"]') as HTMLSelectElement;
    fireEvent.change(effort, { target: { value: 'max' } });

    expect(screen.getByRole('button', { name: /save/i })).toBeTruthy();
  });

  it('discard button removes the dirty state', () => {
    render(
      <Wrapper>
        <AgentTreeView nodes={nodes} file="demo/00-plan.mdx" />
      </Wrapper>,
    );

    const row = screen.getByText('impl').closest('[data-agent-name]') as HTMLElement;
    const effort = row.querySelector('select[data-field="effort"]') as HTMLSelectElement;
    fireEvent.change(effort, { target: { value: 'max' } });

    expect(screen.getByRole('button', { name: /save/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /discard/i }));

    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('save button calls PUT /api/agent-tree', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    render(
      <Wrapper>
        <AgentTreeView nodes={nodes} file="demo/00-plan.mdx" />
      </Wrapper>,
    );

    const row = screen.getByText('impl').closest('[data-agent-name]') as HTMLElement;
    const effort = row.querySelector('select[data-field="effort"]') as HTMLSelectElement;
    fireEvent.change(effort, { target: { value: 'max' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agent-tree');
    expect((opts.method as string).toUpperCase()).toBe('PUT');
    const body = JSON.parse(opts.body as string) as { file: string; tree: AgentTreeNode[] };
    expect(body.file).toBe('demo/00-plan.mdx');
    // impl node should now have effort 'max'
    const implNode = body.tree[0].subAgents?.find((n) => n.name === 'impl');
    expect(implNode?.effort).toBe('max');
  });

  it('subAgents are recursed correctly — nested effort change', () => {
    const deepNodes: AgentTreeNode[] = [
      {
        name: 'root',
        type: 'orchestrator',
        subAgents: [
          {
            name: 'mid',
            type: 'sub-agent',
            subAgents: [{ name: 'leaf', type: 'sub-agent' }],
          },
        ],
      },
    ];

    render(
      <Wrapper>
        <AgentTreeView nodes={deepNodes} file="demo/deep.mdx" />
      </Wrapper>,
    );

    const leafRow = screen.getByText('leaf').closest('[data-agent-name]') as HTMLElement;
    const effortSel = leafRow.querySelector('select[data-field="effort"]') as HTMLSelectElement;
    fireEvent.change(effortSel, { target: { value: 'low' } });

    expect(screen.getByRole('button', { name: /save/i })).toBeTruthy();
  });

  it('renders read-only AgentTree when editable without a file (empty currentFile)', () => {
    render(
      <Wrapper>
        <AgentTree nodes={nodes} />
      </Wrapper>,
    );

    // Read-only AgentTree should have no editable controls
    const effortSelects = screen.queryAllByRole('combobox', { hidden: true });
    expect(effortSelects).toHaveLength(0);
  });
});
