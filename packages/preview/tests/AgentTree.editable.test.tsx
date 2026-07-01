/**
 * Tests for the editable AgentTree — model/effort dropdowns + Save/Discard.
 *
 * Editability now lives in the spec-kit AgentTree, driven by the
 * AgentTreeControlsContext the preview supplies (AgentTreeControlsProvider). This
 * makes an AgentTree authored in MDX interactive regardless of whether the MDX
 * `import`ed it — an import can no longer shadow the behavior. Replaces the old
 * AgentTreeView tests.
 */

import type { AgentTreeNode } from '@synergy/spec-kit';
import { AgentTree } from '@synergy/spec-kit';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTreeControlsProvider } from '../src/AgentTreeControls.js';
import { EditBufferProvider, useEditBuffer } from '../src/EditBuffer.js';
import { ToastProvider } from '../src/ToastProvider.js';

// Mock fetch so applyOne (Save) does not explode.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Sets the buffer's active file, the way SpecPage/PhasePage do on mount. */
function SetCurrentFile({ file }: { file: string }) {
  const { setCurrentFile } = useEditBuffer();
  useEffect(() => {
    setCurrentFile(file);
  }, [file, setCurrentFile]);
  return null;
}

/** Editable harness: active file set + controls context provided. */
function Editable({ file, children }: { file: string; children: ReactNode }) {
  return (
    <ToastProvider>
      <EditBufferProvider>
        <SetCurrentFile file={file} />
        <AgentTreeControlsProvider>{children}</AgentTreeControlsProvider>
      </EditBufferProvider>
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

describe('AgentTree (editable via AgentTreeControlsContext)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('marks the tree dirty after an effort change', () => {
    render(
      <Editable file="demo/00-plan.mdx">
        <AgentTree nodes={nodes} />
      </Editable>,
    );
    const row = screen.getByText('impl').closest('[data-agent-name]') as HTMLElement;
    const effort = row.querySelector('select[data-field="effort"]') as HTMLSelectElement;
    fireEvent.change(effort, { target: { value: 'max' } });
    expect(screen.getByRole('button', { name: /save/i })).toBeTruthy();
  });

  it('discard button removes the dirty state', () => {
    render(
      <Editable file="demo/00-plan.mdx">
        <AgentTree nodes={nodes} />
      </Editable>,
    );
    const row = screen.getByText('impl').closest('[data-agent-name]') as HTMLElement;
    const effort = row.querySelector('select[data-field="effort"]') as HTMLSelectElement;
    fireEvent.change(effort, { target: { value: 'max' } });
    expect(screen.getByRole('button', { name: /save/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('save button calls PUT /api/agent-tree with the edited tree', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(
      <Editable file="demo/00-plan.mdx">
        <AgentTree nodes={nodes} />
      </Editable>,
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
    const implNode = body.tree[0].subAgents?.find((n) => n.name === 'impl');
    expect(implNode?.effort).toBe('max');
  });

  it('recurses into subAgents — nested effort change marks dirty', () => {
    const deepNodes: AgentTreeNode[] = [
      {
        name: 'root',
        type: 'orchestrator',
        subAgents: [
          { name: 'mid', type: 'sub-agent', subAgents: [{ name: 'leaf', type: 'sub-agent' }] },
        ],
      },
    ];
    render(
      <Editable file="demo/deep.mdx">
        <AgentTree nodes={deepNodes} />
      </Editable>,
    );
    const leafRow = screen.getByText('leaf').closest('[data-agent-name]') as HTMLElement;
    const effortSel = leafRow.querySelector('select[data-field="effort"]') as HTMLSelectElement;
    fireEvent.change(effortSel, { target: { value: 'low' } });
    expect(screen.getByRole('button', { name: /save/i })).toBeTruthy();
  });

  it('renders read-only (no controls) when there is no active file', () => {
    render(
      <ToastProvider>
        <EditBufferProvider>
          <AgentTreeControlsProvider>
            <AgentTree nodes={nodes} />
          </AgentTreeControlsProvider>
        </EditBufferProvider>
      </ToastProvider>,
    );
    // No currentFile → factory returns null → read-only, no <select> controls.
    expect(screen.queryAllByRole('combobox', { hidden: true })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });
});
