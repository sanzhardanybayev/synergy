import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { type ExecutionRosterEntry, ExecutionStateProvider } from '../src/ExecutionState.js';
import { Timeline } from '../src/components/Timeline.js';

function withState(
  node: ReactNode,
  roster: ExecutionRosterEntry[],
  derived = { done: 0, total: roster.length, percent: 0 },
) {
  return render(
    <ExecutionStateProvider value={{ phases: {}, roster, derived }}>{node}</ExecutionStateProvider>,
  );
}

describe('Timeline — phase-driven', () => {
  it('renders a step per roster entry with number + title + status', () => {
    withState(
      <Timeline />,
      [
        { number: 1, slug: 'storage', title: 'Storage layer', status: 'done' },
        { number: 2, slug: 'cutover', title: 'Cutover to new store', status: 'in-progress' },
      ],
      { done: 1, total: 2, percent: 50 },
    );
    expect(screen.getByText('Storage layer')).toBeTruthy();
    expect(screen.getByText('Cutover to new store')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByTestId('timeline-bar-fill').style.width).toBe('50%');
  });

  it('renders nothing when the roster is empty and no milestones are given', () => {
    const { container } = withState(<Timeline />, []);
    expect(container.querySelector('.sk-timeline')).toBeNull();
  });

  it('still renders the legacy milestone form', () => {
    render(<Timeline milestones={[{ label: 'Plan approved', status: 'proposed' }]} />);
    expect(screen.getByText('Plan approved')).toBeTruthy();
  });
});
