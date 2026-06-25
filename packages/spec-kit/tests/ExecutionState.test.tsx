import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExecutionStateProvider, useExecutionState } from '../src/ExecutionState.js';

function Probe() {
  const { roster, derived } = useExecutionState();
  return (
    <div data-testid="probe">
      {roster?.length ?? -1}:{derived?.percent ?? -1}
    </div>
  );
}

describe('ExecutionState context', () => {
  it('defaults roster to empty and derived to zero', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('0:0');
  });

  it('passes roster and derived through the provider', () => {
    render(
      <ExecutionStateProvider
        value={{
          phases: {},
          roster: [{ number: 1, slug: 'storage', title: 'Storage layer', status: 'done' }],
          derived: { done: 1, total: 2, percent: 50 },
        }}
      >
        <Probe />
      </ExecutionStateProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('1:50');
  });
});
