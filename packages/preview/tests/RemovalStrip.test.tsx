import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RemovalStrip } from '../src/review/RemovalStrip.js';

const strip = {
  run: { start: 41, end: 43, lineIds: ['r1', 'r2', 'r3'], texts: ['a', 'b', 'c'] },
  rationale: {
    reviewItemId: 'item-1',
    run: { path: 'a.ts', start: 41, end: 43 },
    reason: 'moved' as const,
    description: 'Refresh converged into the interceptor.',
    movedTo: { path: 'b.ts', start: 88, end: 89 },
  },
  target: {
    kind: 'in-review' as const,
    reviewItemId: 'item-2',
    rowIds: ['r9'],
    path: 'b.ts',
    start: 88,
    end: 89,
  },
};

describe('RemovalStrip', () => {
  it('shows the category and line count while collapsed', () => {
    render(<RemovalStrip strip={strip} expanded={false} onToggle={() => {}} onJump={() => {}} />);
    expect(screen.getByText('moved')).toBeTruthy();
    expect(screen.getByText(/3 lines removed/)).toBeTruthy();
    expect(screen.queryByText(/converged into the interceptor/)).toBeNull();
  });

  it('shows the sentence when expanded', () => {
    render(<RemovalStrip strip={strip} expanded onToggle={() => {}} onJump={() => {}} />);
    expect(screen.getByText(/converged into the interceptor/)).toBeTruthy();
  });

  it('calls onJump with the resolved target', () => {
    const onJump = vi.fn();
    render(<RemovalStrip strip={strip} expanded onToggle={() => {}} onJump={onJump} />);
    screen.getByRole('button', { name: /b\.ts:88/ }).click();
    expect(onJump).toHaveBeenCalledWith(strip.target);
  });

  it('keeps the toggle and the jump chip as siblings in one row container, not nested', () => {
    render(<RemovalStrip strip={strip} expanded={false} onToggle={() => {}} onJump={() => {}} />);
    const toggle = screen.getByRole('button', { expanded: false });
    const jump = screen.getByRole('button', { name: /b\.ts:88/ });
    // jsdom computes no layout, so a CSS regression that stacks these two rows can't be caught by
    // measuring pixels here - pinning the DOM shape they rely on (one shared flex row container,
    // chip NOT nested inside the toggle button) is the next best thing.
    expect(jump.parentElement).toBe(toggle.parentElement);
    expect(jump.parentElement).toHaveClass('review-removal__row');
    expect(toggle.contains(jump)).toBe(false);
  });

  it('renders the excerpt instead of a jump for an out-of-review target', () => {
    const excerptStrip = {
      ...strip,
      target: { kind: 'excerpt' as const, path: 'b.ts', start: 88, lines: ['if (x) {', '}'] },
    };
    render(<RemovalStrip strip={excerptStrip} expanded onToggle={() => {}} onJump={() => {}} />);
    expect(screen.queryByRole('button', { name: /b\.ts:88/ })).toBeNull();
    expect(screen.getByText('if (x) {')).toBeTruthy();
  });

  it('renders nothing when a run has no rationale', () => {
    const { container } = render(
      <RemovalStrip
        strip={{ run: strip.run, target: { kind: 'unresolved' } }}
        expanded={false}
        onToggle={() => {}}
        onJump={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
