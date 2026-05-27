import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentAllocation } from '../src/components/AgentAllocation.js';

describe('AgentAllocation fan-out metadata', () => {
  it('renders model + effort + count when provided', () => {
    render(
      <AgentAllocation
        entries={[
          {
            name: 'storage-impl',
            type: 'sub-agent',
            responsibility: 'Implement TokenStore',
            phases: ['storage'],
            model: 'opus',
            effort: 'high',
            count: 2,
          },
        ]}
      />,
    );
    expect(screen.getByText(/opus/)).toBeTruthy();
    expect(screen.getByText(/high/)).toBeTruthy();
    expect(screen.getByText(/×2|x2|2/)).toBeTruthy();
  });

  it('accepts slug phases', () => {
    render(
      <AgentAllocation
        entries={[{ name: 'a', type: 'sub-agent', responsibility: 'r', phases: ['cutover'] }]}
      />,
    );
    expect(screen.getByText('cutover')).toBeTruthy();
  });
});
