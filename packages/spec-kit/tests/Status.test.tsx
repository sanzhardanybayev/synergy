import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Status } from '../src/components/Status.js';

describe('Status — default (read-only) render', () => {
  it('renders a span, not a button', () => {
    render(<Status value="draft" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Draft')).toBeTruthy();
  });

  it('shows the correct label for each status value', () => {
    const cases = [
      ['draft', 'Draft'],
      ['proposed', 'Proposed'],
      ['in-progress', 'In progress'],
      ['blocked', 'Blocked'],
      ['done', 'Done'],
      ['shipped', 'Shipped'],
    ] as const;

    for (const [value, label] of cases) {
      const { unmount } = render(<Status value={value} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it('renders the note when provided', () => {
    render(<Status value="blocked" note="waiting on API" />);
    expect(screen.getByText(/waiting on API/)).toBeTruthy();
  });

  it('does not render the pending indicator when dirty is false', () => {
    render(<Status value="draft" />);
    expect(screen.queryByLabelText('pending change')).toBeNull();
  });

  it('does not render the pending indicator when dirty is not set', () => {
    render(<Status value="done" />);
    expect(screen.queryByLabelText('pending change')).toBeNull();
  });
});

describe('Status — dirty indicator', () => {
  it('renders the pending indicator when dirty=true', () => {
    render(<Status value="draft" editable dirty />);
    expect(screen.getByLabelText('pending change')).toBeTruthy();
  });

  it('renders the pending indicator in read-only mode when dirty=true', () => {
    render(<Status value="draft" dirty />);
    expect(screen.getByLabelText('pending change')).toBeTruthy();
  });
});

describe('Status — editable', () => {
  it('renders as a button when editable=true', () => {
    render(<Status value="draft" editable />);
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('button has aria-haspopup="listbox" and aria-expanded=false when closed', () => {
    render(<Status value="draft" editable />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-haspopup', 'listbox');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('click opens the popover with 6 options', async () => {
    const user = userEvent.setup();
    render(<Status value="draft" editable />);

    const btn = screen.getByRole('button');
    await user.click(btn);

    expect(btn).toHaveAttribute('aria-expanded', 'true');

    const listbox = screen.getByRole('listbox');
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(6);
  });

  it('current value option has aria-selected=true', async () => {
    const user = userEvent.setup();
    render(<Status value="in-progress" editable />);
    await user.click(screen.getByRole('button'));

    const listbox = screen.getByRole('listbox');
    const options = within(listbox).getAllByRole('option');
    const selected = options.filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('In progress');
  });

  it('selecting an option calls onChange with the new value and closes the popover', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Status value="draft" editable onChange={onChange} />);

    await user.click(screen.getByRole('button'));

    const listbox = screen.getByRole('listbox');
    const shippedOption = within(listbox).getByText('Shipped');
    await user.click(shippedOption);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('shipped');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape closes the popover without calling onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Status value="draft" editable onChange={onChange} />);

    const btn = screen.getByRole('button');
    await user.click(btn);
    expect(screen.getByRole('listbox')).toBeTruthy();

    await user.keyboard('{Escape}');

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('click outside closes the popover without calling onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <div>
        <Status value="draft" editable onChange={onChange} />
        <p data-testid="outside">outside</p>
      </div>,
    );

    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeTruthy();

    await user.click(screen.getByTestId('outside'));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not render a popover on initial render', () => {
    render(<Status value="done" editable />);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
