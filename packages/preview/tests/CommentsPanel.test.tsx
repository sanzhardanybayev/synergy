/**
 * Tests for CommentsPanel.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentsPanel } from '../src/CommentsPanel.js';
import { ToastProvider } from '../src/ToastProvider.js';
import type { Comment } from '../src/api.js';

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'test-id-1',
    session: '2026-05-25-foo',
    file: '00-overview.mdx',
    status: 'open',
    created: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
    anchor: {
      lineStart: 5,
      colStart: 4,
      lineEnd: 5,
      colEnd: 10,
      before: 'sign in via ',
      selected: 'OAuth',
      after: ' to continue',
    },
    body: 'Should this cover SAML too?',
    ...overrides,
  };
}

function makeResponse(comments: Comment[]) {
  return Promise.resolve(new Response(JSON.stringify({ comments }), { status: 200 }));
}

function okPatch() {
  return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

function renderPanel(props: Partial<React.ComponentProps<typeof CommentsPanel>> = {}) {
  return render(
    <ToastProvider>
      <CommentsPanel session="2026-05-25-foo" {...props} />
    </ToastProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommentsPanel', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('renders fetched open comments', async () => {
    const comments = [makeComment({ id: 'c1' })];
    mockFetch.mockImplementation(() => makeResponse(comments));

    renderPanel();

    // Comment body should appear.
    expect(await screen.findByText('Should this cover SAML too?')).toBeInTheDocument();
    // Anchor selected text shown.
    expect(screen.getByText('OAuth')).toBeInTheDocument();
  });

  it('shows "No open comments" when list is empty', async () => {
    mockFetch.mockImplementation(() => makeResponse([]));
    renderPanel();
    expect(await screen.findByText(/no open comments/i)).toBeInTheDocument();
  });

  it('calls Resolve and fires PATCH resolved', async () => {
    const comment = makeComment({ id: 'resolve-me' });
    // First call: list, second call: patch, third call: refetch after resolve.
    mockFetch
      .mockImplementationOnce(() => makeResponse([comment]))
      .mockImplementationOnce(okPatch)
      .mockImplementationOnce(() => makeResponse([]));

    renderPanel();
    await screen.findByText(comment.body);

    const resolveBtn = screen.getByRole('button', { name: /resolve/i });
    await userEvent.click(resolveBtn);

    // Patch call.
    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find((c) => c[0] === '/api/feedback/resolve-me');
      expect(patchCall).toBeDefined();
      const body = JSON.parse(patchCall![1].body as string);
      expect(body.status).toBe('resolved');
    });
  });

  it('prompts for rejection reason then fires PATCH rejected', async () => {
    const comment = makeComment({ id: 'reject-me' });
    mockFetch
      .mockImplementationOnce(() => makeResponse([comment]))
      .mockImplementationOnce(okPatch)
      .mockImplementationOnce(() => makeResponse([]));

    renderPanel();
    await screen.findByText(comment.body);

    const rejectBtn = screen.getByRole('button', { name: /reject/i });
    await userEvent.click(rejectBtn);

    // Reason input should appear.
    const input = screen.getByPlaceholderText(/reason/i);
    await userEvent.type(input, 'Out of scope');

    const submitBtn = screen.getByRole('button', { name: /submit/i });
    await userEvent.click(submitBtn);

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find((c) => c[0] === '/api/feedback/reject-me');
      expect(patchCall).toBeDefined();
      const body = JSON.parse(patchCall![1].body as string);
      expect(body.status).toBe('rejected');
      expect(body.rejection_reason).toBe('Out of scope');
    });
  });

  it('hides resolved comments by default and shows them after toggle', async () => {
    const open = makeComment({ id: 'open-1', status: 'open', body: 'Open comment' });
    const resolved = makeComment({
      id: 'resolved-1',
      status: 'resolved',
      body: 'Resolved comment',
      resolution: 'Done',
    });
    mockFetch.mockImplementation(() => makeResponse([open, resolved]));

    renderPanel();
    await screen.findByText('Open comment');

    // Resolved comment should be hidden by default.
    expect(screen.queryByText('Resolved comment')).toBeNull();

    // Toggle to show resolved.
    const toggle = screen.getByRole('button', { name: /show resolved/i });
    await userEvent.click(toggle);

    expect(screen.getByText('Resolved comment')).toBeInTheDocument();
  });

  it('calls onCountChange with the open comment count', async () => {
    const onCountChange = vi.fn();
    mockFetch.mockImplementation(() => makeResponse([makeComment(), makeComment({ id: 'c2' })]));

    renderPanel({ onCountChange });

    await waitFor(() => {
      expect(onCountChange).toHaveBeenCalledWith(2);
    });
  });

  it('calls onScrollToAnchor when a comment card is clicked', async () => {
    const onScrollToAnchor = vi.fn();
    const comment = makeComment({ id: 'scroll-me' });
    mockFetch.mockImplementation(() => makeResponse([comment]));

    renderPanel({ onScrollToAnchor });
    await screen.findByText(comment.body);

    await userEvent.click(screen.getByRole('article'));

    expect(onScrollToAnchor).toHaveBeenCalledWith(expect.objectContaining({ id: 'scroll-me' }));
  });

  it('refetches when refreshKey changes', async () => {
    const first = makeComment({ id: 'f1', body: 'First batch' });
    const second = makeComment({ id: 'f2', body: 'Second batch' });
    mockFetch
      .mockImplementationOnce(() => makeResponse([first]))
      .mockImplementationOnce(() => makeResponse([second]));

    const { rerender } = renderPanel({ refreshKey: 0 });
    await screen.findByText('First batch');

    rerender(
      <ToastProvider>
        <CommentsPanel session="2026-05-25-foo" refreshKey={1} />
      </ToastProvider>,
    );

    expect(await screen.findByText('Second batch')).toBeInTheDocument();
  });
});
