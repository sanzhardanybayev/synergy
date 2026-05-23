import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copyToClipboard = vi.fn();
vi.mock('../src/clipboard', () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboard(...args),
}));

import { CopyButton } from '../src/CopyButton';
import { ToastProvider } from '../src/ToastProvider';

function renderWithToast(ui: ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe('CopyButton', () => {
  beforeEach(() => {
    copyToClipboard.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the value to the clipboard on click', async () => {
    const user = userEvent.setup();
    renderWithToast(<CopyButton label="Session path" value="/abs/path" />);
    await user.click(screen.getByRole('button', { name: /session path/i }));
    await screen.findByRole('status');
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenCalledWith('/abs/path');
  });

  it('shows a Copied! toast on success', async () => {
    const user = userEvent.setup();
    renderWithToast(<CopyButton label="Session path" value="/abs/path" />);
    await user.click(screen.getByRole('button', { name: /session path/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/copied/i);
  });

  it('shows a failure toast when the clipboard returns false', async () => {
    copyToClipboard.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    renderWithToast(<CopyButton label="Session path" value="/abs/path" />);
    await user.click(screen.getByRole('button', { name: /session path/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/copy failed/i);
  });

  it('auto-dismisses the toast after ~2s', async () => {
    const user = userEvent.setup();
    renderWithToast(<CopyButton label="Session path" value="/abs/path" />);
    await user.click(screen.getByRole('button', { name: /session path/i }));
    expect(await screen.findByRole('status')).toBeInTheDocument();
    // Real timer wait. The toast should disappear within 2s + a small grace.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200));
    });
    expect(screen.queryByRole('status')).toBeNull();
  }, 4000);

  it('uses the value as a tooltip on the button', () => {
    renderWithToast(<CopyButton label="Session path" value="/abs/path" />);
    expect(screen.getByRole('button', { name: /session path/i })).toHaveAttribute(
      'title',
      '/abs/path',
    );
  });
});
