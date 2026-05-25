import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Phase } from '../src/components/Phase.js';

describe('Phase — default render', () => {
  it('renders the phase number and title', () => {
    render(<Phase number={1} title="Core Infrastructure" />);
    expect(screen.getByText('Phase 1')).toBeTruthy();
    expect(screen.getByText('Core Infrastructure')).toBeTruthy();
  });

  it('renders status as a plain span (not a button) by default', () => {
    render(<Phase number={1} title="Core" status="in-progress" />);
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders the estimate when provided', () => {
    render(<Phase number={1} title="Core" estimate="2d" />);
    expect(screen.getByText(/2d/)).toBeTruthy();
  });

  it('renders summary when provided', () => {
    render(<Phase number={1} title="Core" summary="Brief summary text" />);
    expect(screen.getByText('Brief summary text')).toBeTruthy();
  });

  it('renders children in the body', () => {
    render(
      <Phase number={2} title="Phase Two">
        <p>child content</p>
      </Phase>,
    );
    expect(screen.getByText('child content')).toBeTruthy();
  });

  it('does not render the pending indicator without statusDirty', () => {
    render(<Phase number={1} title="Core" status="draft" />);
    expect(screen.queryByLabelText('pending change')).toBeNull();
  });

  it('does not render a status badge when status prop is omitted', () => {
    render(<Phase number={1} title="No Status" />);
    expect(screen.queryByRole('button')).toBeNull();
    // No status text at all
    const texts = ['Draft', 'Proposed', 'In progress', 'Blocked', 'Done', 'Shipped'];
    for (const t of texts) expect(screen.queryByText(t)).toBeNull();
  });
});

describe('Phase — editable', () => {
  it('status badge becomes a button when editable=true', () => {
    render(<Phase number={1} title="Core" status="draft" editable />);
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('clicking the status badge opens the popover', async () => {
    const user = userEvent.setup();
    render(<Phase number={1} title="Core" status="proposed" editable />);

    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeTruthy();

    const listbox = screen.getByRole('listbox');
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(6);
  });

  it('selecting a status option calls onStatusChange with the new value', async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn();
    render(
      <Phase number={1} title="Core" status="draft" editable onStatusChange={onStatusChange} />,
    );

    await user.click(screen.getByRole('button'));

    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByText('Done'));

    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith('done');
  });

  it('popover closes after selection', async () => {
    const user = userEvent.setup();
    render(<Phase number={1} title="Core" status="draft" editable onStatusChange={vi.fn()} />);

    await user.click(screen.getByRole('button'));
    await user.click(within(screen.getByRole('listbox')).getByText('Shipped'));

    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('Phase — statusDirty', () => {
  it('shows the pending indicator when statusDirty=true', () => {
    render(<Phase number={1} title="Core" status="draft" editable statusDirty />);
    expect(screen.getByLabelText('pending change')).toBeTruthy();
  });

  it('does not show the pending indicator when statusDirty is false', () => {
    render(<Phase number={1} title="Core" status="draft" editable statusDirty={false} />);
    expect(screen.queryByLabelText('pending change')).toBeNull();
  });
});
