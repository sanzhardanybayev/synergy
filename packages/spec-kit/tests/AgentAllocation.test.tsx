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
