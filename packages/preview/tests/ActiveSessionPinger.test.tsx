/**
 * Tests for ActiveSessionPinger.
 * Mocks fetch to verify ping behaviour on mount and window focus.
 */

import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { ActiveSessionPinger } from '../src/ActiveSessionPinger.js';

function okResponse() {
  return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

describe('ActiveSessionPinger', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(okResponse);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing (returns null)', () => {
    const { container } = render(<ActiveSessionPinger session="2026-05-25-foo" />);
    expect(container.firstChild).toBeNull();
  });

  it('pings POST /api/active-session on mount', async () => {
    render(<ActiveSessionPinger session="2026-05-25-foo" />);

    // Allow microtasks/promises to settle.
    await vi.runAllTimersAsync();

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/active-session',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ session: '2026-05-25-foo' }),
      }),
    );
  });

  it('pings on window focus', async () => {
    render(<ActiveSessionPinger session="2026-05-25-bar" />);
    await vi.runAllTimersAsync();
    const initialCalls = mockFetch.mock.calls.length;

    // Advance time past debounce window.
    vi.advanceTimersByTime(1100);

    window.dispatchEvent(new Event('focus'));
    await vi.runAllTimersAsync();

    expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCalls);
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    expect(lastCall[0]).toBe('/api/active-session');
    expect(JSON.parse(lastCall[1].body as string)).toEqual({ session: '2026-05-25-bar' });
  });

  it('debounces rapid pings — second ping within 1s is ignored', async () => {
    render(<ActiveSessionPinger session="2026-05-25-baz" />);
    await vi.runAllTimersAsync();
    const countAfterMount = mockFetch.mock.calls.length;

    // Fire focus immediately (within debounce window).
    window.dispatchEvent(new Event('focus'));
    await vi.runAllTimersAsync();

    // Should NOT have fired again.
    expect(mockFetch.mock.calls.length).toBe(countAfterMount);
  });

  it('pings again when session prop changes', async () => {
    const { rerender } = render(<ActiveSessionPinger session="2026-05-25-first" />);
    await vi.runAllTimersAsync();
    const countAfterFirst = mockFetch.mock.calls.length;

    // Advance past debounce.
    vi.advanceTimersByTime(1100);

    rerender(<ActiveSessionPinger session="2026-05-25-second" />);
    await vi.runAllTimersAsync();

    expect(mockFetch.mock.calls.length).toBeGreaterThan(countAfterFirst);
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    expect(JSON.parse(lastCall[1].body as string)).toEqual({ session: '2026-05-25-second' });
  });

  it('removes focus listener on unmount', async () => {
    const { unmount } = render(<ActiveSessionPinger session="2026-05-25-foo" />);
    await vi.runAllTimersAsync();
    unmount();

    // Advance past debounce.
    vi.advanceTimersByTime(1100);
    const countAfterUnmount = mockFetch.mock.calls.length;

    window.dispatchEvent(new Event('focus'));
    await vi.runAllTimersAsync();

    expect(mockFetch.mock.calls.length).toBe(countAfterUnmount);
  });
});
