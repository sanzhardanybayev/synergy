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
    subAgents: [{ name: 'storage-impl', type: 'sub-agent', model: 'sonnet' }],
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

  it('renders count ×N when node.count > 1', () => {
    const withCount: AgentTreeNode[] = [
      {
        name: 'orchestrator',
        type: 'orchestrator',
        effort: 'high',
        model: 'opus',
        subAgents: [{ name: 'worker', type: 'sub-agent', model: 'sonnet', count: 3 }],
      },
    ];
    render(<AgentTree nodes={withCount} />);
    const row = screen.getByText('worker').closest('[data-agent-name]') as HTMLElement;
    expect(row.textContent).toContain('×3');
    expect(row.querySelector('.sk-agent-tree__count')).toBeTruthy();
  });

  it('does not render a count span when count is absent', () => {
    render(<AgentTree nodes={nodes} />);
    const row = screen.getByText('storage-impl').closest('[data-agent-name]') as HTMLElement;
    expect(row.querySelector('.sk-agent-tree__count')).toBeNull();
  });
});
