/**
 * Tests for TopToolbar.
 *
 * Tests:
 *  - Apply-all count matches dirty buffer entries
 *  - Diff toggle flips diffMode in the buffer
 *  - Comment badge shows openComments
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditBufferProvider, useEditBuffer } from '../src/EditBuffer.js';
import { ToastProvider } from '../src/ToastProvider.js';
import { TopToolbar } from '../src/TopToolbar.js';

// ---------------------------------------------------------------------------
// Mock fetch — needed by applyAll in the buffer
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <EditBufferProvider>{children}</EditBufferProvider>
    </ToastProvider>
  );
}

/** Seed the buffer with N prose entries so dirtyCount=N. */
function BufferSeeder({ count }: { count: number }) {
  // Depend on the stable setter (not the whole buffer object) so this effect
  // runs once; depending on `buffer` would re-fire on every value change.
  const { setDirtyProse } = useEditBuffer();
  useEffect(() => {
    for (let i = 0; i < count; i++) {
      setDirtyProse(`key-${i}`, {
        kind: 'prose',
        file: 'f.mdx',
        sourceStart: { line: i + 1, col: 0 },
        sourceEnd: { line: i + 1, col: 5 },
        originalText: 'old',
        currentText: 'new',
      });
    }
  }, [setDirtyProse, count]);
  return null;
}

function renderToolbar(props: {
  openComments?: number;
  diffOn?: boolean;
  onToggleDiff?: () => void;
  dirtyCount?: number;
}) {
  const { openComments = 0, diffOn = false, onToggleDiff = vi.fn(), dirtyCount = 0 } = props;
  return render(
    <Wrapper>
      {dirtyCount > 0 && <BufferSeeder count={dirtyCount} />}
      <TopToolbar openComments={openComments} diffOn={diffOn} onToggleDiff={onToggleDiff} />
    </Wrapper>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TopToolbar', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, newSize: 50 }), { status: 200 })),
    );
  });

  it('shows "Apply all (0)" and disables when no dirty edits', () => {
    renderToolbar({ dirtyCount: 0 });
    const btn = screen.getByRole('button', { name: /apply all/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Apply all (0)');
  });

  it('Apply all count matches the number of dirty buffer entries', () => {
    renderToolbar({ dirtyCount: 3 });
    const btn = screen.getByRole('button', { name: /apply all/i });
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveTextContent('Apply all (3)');
  });

  it('Discard all button is disabled when no dirty edits', () => {
    renderToolbar({ dirtyCount: 0 });
    expect(screen.getByRole('button', { name: /discard all/i })).toBeDisabled();
  });

  it('Discard all button is enabled when dirty edits exist', () => {
    renderToolbar({ dirtyCount: 2 });
    expect(screen.getByRole('button', { name: /discard all/i })).not.toBeDisabled();
  });

  it('Diff toggle calls onToggleDiff when clicked', async () => {
    const onToggleDiff = vi.fn();
    renderToolbar({ onToggleDiff });

    await userEvent.click(screen.getByRole('button', { name: /diff/i }));
    expect(onToggleDiff).toHaveBeenCalledTimes(1);
  });

  it('shows "Diff: off" when diffOn=false', () => {
    renderToolbar({ diffOn: false });
    expect(screen.getByRole('button', { name: /diff view: off/i })).toBeInTheDocument();
  });

  it('shows "Diff: on" when diffOn=true', () => {
    renderToolbar({ diffOn: true });
    expect(screen.getByRole('button', { name: /diff view: on/i })).toBeInTheDocument();
  });

  it('Apply all is disabled when diffMode is on in the buffer', async () => {
    const { rerender } = render(
      <Wrapper>
        <BufferSeeder count={2} />
        <TopToolbar openComments={0} diffOn={false} onToggleDiff={vi.fn()} />
      </Wrapper>,
    );

    // Apply should be enabled initially.
    expect(screen.getByRole('button', { name: /apply all/i })).not.toBeDisabled();

    // Now enable diffMode on the buffer by re-rendering with diffOn=true.
    // The ToolbarWrapper below sets buffer.setDiffMode via the toggle.
    // Instead we use a helper component.
    rerender(
      <Wrapper>
        <BufferSeeder count={2} />
        <DiffModeSetter on={true} />
        <TopToolbar openComments={0} diffOn={true} onToggleDiff={vi.fn()} />
      </Wrapper>,
    );

    await act(async () => {});
    expect(screen.getByRole('button', { name: /apply all/i })).toBeDisabled();
  });

  it('comment badge shows openComments count', () => {
    renderToolbar({ openComments: 5 });
    expect(screen.getByLabelText(/5 open comments/i)).toBeInTheDocument();
  });

  it('comment badge is hidden when openComments=0', () => {
    renderToolbar({ openComments: 0 });
    expect(screen.queryByLabelText(/open comments/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Helper component for diffMode
// ---------------------------------------------------------------------------

function DiffModeSetter({ on }: { on: boolean }) {
  const { setDiffMode } = useEditBuffer();
  useEffect(() => {
    setDiffMode(on);
  }, [setDiffMode, on]);
  return null;
}
