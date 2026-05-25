/**
 * Tests for CommentLayer — selection → "+" → composer → POST.
 *
 * We simulate a text selection by manipulating window.getSelection() and
 * then triggering selectionchange. The block element carries
 * data-source-* attributes as emitted by rehype-source-range.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentLayer } from '../src/CommentLayer.js';
import { ToastProvider } from '../src/ToastProvider.js';

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okFeedback() {
  return Promise.resolve(
    new Response(
      JSON.stringify({ id: '2026-05-25T093045-abc123', path: '.synergy/feedback/sess/id.md' }),
      { status: 200 },
    ),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal DOM structure that matches what rehype-source-range emits.
 * Returns the block element so tests can drive selections on it.
 */
function renderWithBlock(
  props: Partial<React.ComponentProps<typeof CommentLayer>> = {},
  blockText = 'we sign users in via SSO and redirect',
) {
  // fileSource: single-line matching blockText starting at line 1, col 0.
  const fileSource = blockText;

  const { container } = render(
    <ToastProvider>
      <div className="mdx-body">
        <p
          data-source-line-start="1"
          data-source-col-start="0"
          data-source-line-end="1"
          data-source-col-end={String(blockText.length)}
        >
          {blockText}
        </p>
      </div>
      <CommentLayer
        session="2026-05-25-sess"
        file="00-overview.mdx"
        fileSource={fileSource}
        {...props}
      />
    </ToastProvider>,
  );

  const block = container.querySelector('p[data-source-line-start]') as HTMLElement;
  return { container, block };
}

/**
 * Simulate a text selection on the text node inside `block`, selecting
 * characters from `startOffset` to `endOffset`.
 * Returns the range so callers can assert on it.
 */
function simulateSelection(block: HTMLElement, startOffset: number, endOffset: number) {
  const textNode = block.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    throw new Error('Block has no text node');
  }

  const range = document.createRange();
  range.setStart(textNode, startOffset);
  range.setEnd(textNode, endOffset);

  // Mock getSelection to return our range.
  const mockSel = {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: vi.fn(() => range),
    toString: vi.fn(() => block.textContent?.slice(startOffset, endOffset) ?? ''),
    removeAllRanges: vi.fn(),
  };
  vi.spyOn(window, 'getSelection').mockReturnValue(mockSel as unknown as Selection);

  // Fire selectionchange.
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });

  return { range, mockSel };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommentLayer', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(okFeedback);
  });

  afterEach(() => {
    // Restore any vi.spyOn spies (e.g. getSelection) set during tests.
    // We do NOT call vi.restoreAllMocks() in beforeEach because it would also
    // unwind the vi.stubGlobal('fetch') stub, leaving globalThis.fetch undefined
    // for the duration of the test.
    vi.restoreAllMocks();
  });

  it('shows "+" button after a non-empty selection inside .mdx-body', async () => {
    const { block } = renderWithBlock();
    // "SSO" is at offset 21..24 in "we sign users in via SSO and redirect"
    simulateSelection(block, 21, 24);

    expect(await screen.findByRole('button', { name: /add comment/i })).toBeInTheDocument();
  });

  it('does not show "+" button for an empty selection', () => {
    renderWithBlock();

    const mockSel = {
      isCollapsed: true,
      rangeCount: 0,
      getRangeAt: vi.fn(),
      toString: vi.fn(() => ''),
      removeAllRanges: vi.fn(),
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(mockSel as unknown as Selection);

    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });

    expect(screen.queryByRole('button', { name: /add comment/i })).toBeNull();
  });

  it('opens composer when "+" is clicked', async () => {
    const { block } = renderWithBlock();
    simulateSelection(block, 21, 24);

    const addBtn = await screen.findByRole('button', { name: /add comment/i });
    await userEvent.click(addBtn);

    expect(screen.getByRole('dialog', { name: /add comment/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/leave a note/i)).toBeInTheDocument();
  });

  it('closes composer on Cancel', async () => {
    const { block } = renderWithBlock();
    simulateSelection(block, 21, 24);

    const addBtn = await screen.findByRole('button', { name: /add comment/i });
    await userEvent.click(addBtn);

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes composer on Esc', async () => {
    const { block } = renderWithBlock();
    simulateSelection(block, 21, 24);

    const addBtn = await screen.findByRole('button', { name: /add comment/i });
    await userEvent.click(addBtn);

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('fires POST /api/feedback with correctly computed anchor on Send', async () => {
    const blockText = 'we sign users in via SSO and redirect';
    const { block } = renderWithBlock({}, blockText);

    // Select "SSO" (offset 21..24)
    simulateSelection(block, 21, 24);

    const addBtn = await screen.findByRole('button', { name: /add comment/i });
    await userEvent.click(addBtn);

    const textarea = screen.getByPlaceholderText(/leave a note/i);
    await userEvent.type(textarea, 'Should this cover SAML?');

    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/feedback',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const feedbackCall = mockFetch.mock.calls.find((c) => c[0] === '/api/feedback');
    expect(feedbackCall).toBeDefined();
    const body = JSON.parse(feedbackCall![1].body as string);

    expect(body.session).toBe('2026-05-25-sess');
    expect(body.file).toBe('00-overview.mdx');
    expect(body.body).toBe('Should this cover SAML?');

    // Anchor checks.
    expect(body.anchor.selected).toBe('SSO');
    expect(body.anchor.lineStart).toBe(1);
    expect(body.anchor.colStart).toBe(21);
    expect(body.anchor.lineEnd).toBe(1);
    expect(body.anchor.colEnd).toBe(24);
    expect(body.anchor.before).toBe('we sign users in via ');
    expect(body.anchor.after).toBe(' and redirect');
  });

  it('calls onPosted after successful POST', async () => {
    const onPosted = vi.fn();
    const { block } = renderWithBlock({ onPosted });
    simulateSelection(block, 21, 24);

    const addBtn = await screen.findByRole('button', { name: /add comment/i });
    await userEvent.click(addBtn);
    await userEvent.type(screen.getByPlaceholderText(/leave a note/i), 'A comment');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(onPosted).toHaveBeenCalledTimes(1));
  });

  it('shows a toast on POST failure', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('Internal error', { status: 500 })),
    );

    const { block } = renderWithBlock();
    simulateSelection(block, 21, 24);

    const addBtn = await screen.findByRole('button', { name: /add comment/i });
    await userEvent.click(addBtn);
    await userEvent.type(screen.getByPlaceholderText(/leave a note/i), 'Failing comment');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('Send button is disabled when textarea is empty', async () => {
    const { block } = renderWithBlock();
    simulateSelection(block, 21, 24);

    const addBtn = await screen.findByRole('button', { name: /add comment/i });
    await userEvent.click(addBtn);

    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });
});
