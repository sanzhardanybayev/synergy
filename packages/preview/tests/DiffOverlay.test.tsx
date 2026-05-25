/**
 * Tests for DiffOverlay.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffOverlay } from '../src/DiffOverlay.js';
import { ToastProvider } from '../src/ToastProvider.js';
import type { DiffResult } from '../src/api.js';

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiff(overrides: Partial<Extract<DiffResult, { available: true }>> = {}): DiffResult {
  return {
    available: true,
    file: '2026-05-25-foo/00-overview.mdx',
    head: 'abc1234',
    reviewedAt: null,
    hunks: [
      {
        oldStart: 14,
        oldLines: 2,
        newStart: 14,
        newLines: 3,
        lines: [
          { kind: 'context', text: '## Goals' },
          { kind: 'remove', text: 'Old line.' },
          { kind: 'add', text: 'New line.' },
          { kind: 'add', text: 'Extra new line.' },
        ],
      },
    ],
    uncommittedHunks: [],
    ...overrides,
  };
}

function makeDiffResponse(diff: DiffResult) {
  const payload = diff.available ? diff : { error: 'not_a_git_repo' };
  return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
}

function okReview() {
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true, reviewedAt: 'abc1234' }), { status: 200 }),
  );
}

function renderOverlay(files: string[] = ['2026-05-25-foo/00-overview.mdx']) {
  return render(
    <ToastProvider>
      <DiffOverlay files={files} />
    </ToastProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiffOverlay', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('renders added and removed line counts in the summary', async () => {
    mockFetch.mockImplementation(() => makeDiffResponse(makeDiff()));
    renderOverlay();

    // +2 added, -1 removed in our fixture.
    expect(await screen.findByText('+2')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();
    expect(screen.getByText(/1 hunk/)).toBeInTheDocument();
  });

  it('renders hunk lines with correct text', async () => {
    mockFetch.mockImplementation(() => makeDiffResponse(makeDiff()));
    renderOverlay();

    expect(await screen.findByText('## Goals')).toBeInTheDocument();
    expect(screen.getByText('Old line.')).toBeInTheDocument();
    expect(screen.getByText('New line.')).toBeInTheDocument();
  });

  it('renders "Mark as reviewed" button when there are changes', async () => {
    mockFetch.mockImplementation(() => makeDiffResponse(makeDiff()));
    renderOverlay();

    expect(await screen.findByRole('button', { name: /mark as reviewed/i })).toBeInTheDocument();
  });

  it('fires POST /api/review on Mark-as-reviewed click', async () => {
    // First call: getDiff, second call: postReview, third call: getDiff refetch.
    mockFetch
      .mockImplementationOnce(() => makeDiffResponse(makeDiff()))
      .mockImplementationOnce(okReview)
      .mockImplementationOnce(() =>
        makeDiffResponse(makeDiff({ hunks: [], uncommittedHunks: [] })),
      );

    renderOverlay(['2026-05-25-foo/00-overview.mdx']);
    const btn = await screen.findByRole('button', { name: /mark as reviewed/i });

    await userEvent.click(btn);

    await waitFor(() => {
      const reviewCall = mockFetch.mock.calls.find((c) => c[0] === '/api/review');
      expect(reviewCall).toBeDefined();
      const body = JSON.parse(reviewCall![1].body as string);
      expect(body.file).toBe('2026-05-25-foo/00-overview.mdx');
    });
  });

  it('shows "Diff unavailable: not a git repo" when API returns not_a_git_repo', async () => {
    mockFetch.mockImplementation(() => makeDiffResponse({ available: false }));
    renderOverlay();

    expect(await screen.findByText(/diff unavailable: not a git repo/i)).toBeInTheDocument();
  });

  it('hides Mark-as-reviewed button when diff is unavailable', async () => {
    mockFetch.mockImplementation(() => makeDiffResponse({ available: false }));
    renderOverlay();
    await screen.findByText(/diff unavailable/i);

    expect(screen.queryByRole('button', { name: /mark as reviewed/i })).toBeNull();
  });

  it('renders uncommitted hunks with the uncommitted label', async () => {
    const diff = makeDiff({
      hunks: [],
      uncommittedHunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: 'remove', text: 'Was here.' },
            { kind: 'add', text: 'Now here.' },
          ],
        },
      ],
    });
    mockFetch.mockImplementation(() => makeDiffResponse(diff));
    renderOverlay();

    await screen.findByText('Was here.');
    expect(screen.getByText(/uncommitted/i)).toBeInTheDocument();
  });

  it('shows "no changes since last review" when all hunk arrays are empty', async () => {
    mockFetch.mockImplementation(() =>
      makeDiffResponse(makeDiff({ hunks: [], uncommittedHunks: [] })),
    );
    renderOverlay();

    expect(await screen.findByText(/no changes since last review/i)).toBeInTheDocument();
  });
});
