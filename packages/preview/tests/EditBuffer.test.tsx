/**
 * Tests for EditBuffer context.
 *
 * Tests: setDirtyProse / setDirtyStatus / applyOne / applyAll / discardAll /
 * dirtyCount; 409 keeps the entry.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditBufferProvider, useEditBuffer } from '../src/EditBuffer.js';
import { ToastProvider } from '../src/ToastProvider.js';

// ---------------------------------------------------------------------------
// Mock fetch
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

function makeEditOkResponse() {
  return Promise.resolve(new Response(JSON.stringify({ ok: true, newSize: 100 }), { status: 200 }));
}

function makeEditStaleResponse(currentText = 'server text') {
  return Promise.resolve(
    new Response(JSON.stringify({ error: 'stale_range', currentText }), { status: 409 }),
  );
}

function makeStatusOkResponse() {
  return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EditBuffer', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('starts empty — dirtyCount=0, isDirty=false', () => {
    const { result } = renderHook(() => useEditBuffer(), { wrapper: Wrapper });
    expect(result.current.dirtyCount).toBe(0);
    expect(result.current.isDirty).toBe(false);
  });

  it('setDirtyProse adds an entry and increments dirtyCount', () => {
    const { result } = renderHook(() => useEditBuffer(), { wrapper: Wrapper });

    act(() => {
      result.current.setCurrentFile('session/00-overview.mdx');
      result.current.setDirtyProse('session/00-overview.mdx:5:0', {
        kind: 'prose',
        file: 'session/00-overview.mdx',
        sourceStart: { line: 5, col: 0 },
        sourceEnd: { line: 5, col: 20 },
        originalText: 'Original text here.',
        currentText: 'Edited text here.',
      });
    });

    expect(result.current.dirtyCount).toBe(1);
    expect(result.current.isDirty).toBe(true);
  });

  it('setDirtyStatus adds a status entry', () => {
    const { result } = renderHook(() => useEditBuffer(), { wrapper: Wrapper });

    act(() => {
      result.current.setDirtyStatus('status:session/phase.mdx:core', {
        kind: 'status',
        file: 'session/phase.mdx',
        phaseSlug: 'core',
        originalStatus: 'draft',
        currentStatus: 'in-progress',
      });
    });

    expect(result.current.dirtyCount).toBe(1);
  });

  it('discard removes an entry', () => {
    const { result } = renderHook(() => useEditBuffer(), { wrapper: Wrapper });
    const key = 'session/file.mdx:1:0';

    act(() => {
      result.current.setDirtyProse(key, {
        kind: 'prose',
        file: 'session/file.mdx',
        sourceStart: { line: 1, col: 0 },
        sourceEnd: { line: 1, col: 10 },
        originalText: 'old',
        currentText: 'new',
      });
    });

    expect(result.current.dirtyCount).toBe(1);

    act(() => {
      result.current.discard(key);
    });

    expect(result.current.dirtyCount).toBe(0);
  });

  it('discardAll clears all entries', () => {
    const { result } = renderHook(() => useEditBuffer(), { wrapper: Wrapper });

    act(() => {
      result.current.setDirtyProse('key1', {
        kind: 'prose',
        file: 'f.mdx',
        sourceStart: { line: 1, col: 0 },
        sourceEnd: { line: 1, col: 5 },
        originalText: 'a',
        currentText: 'b',
      });
      result.current.setDirtyProse('key2', {
        kind: 'prose',
        file: 'f.mdx',
        sourceStart: { line: 2, col: 0 },
        sourceEnd: { line: 2, col: 5 },
        originalText: 'c',
        currentText: 'd',
      });
    });

    expect(result.current.dirtyCount).toBe(2);

    act(() => {
      result.current.discardAll();
    });

    expect(result.current.dirtyCount).toBe(0);
  });

  it('applyOne calls PUT /api/edit and clears the entry on 200', async () => {
    mockFetch.mockImplementationOnce(makeEditOkResponse);
    const { result } = renderHook(() => useEditBuffer(), { wrapper: Wrapper });
    const key = 'session/f.mdx:3:0';

    act(() => {
      result.current.setDirtyProse(key, {
        kind: 'prose',
        file: 'session/f.mdx',
        sourceStart: { line: 3, col: 0 },
        sourceEnd: { line: 3, col: 15 },
        originalText: 'original',
        currentText: 'updated',
      });
    });

    await act(async () => {
      await result.current.applyOne(key);
    });

    await waitFor(() => expect(result.current.dirtyCount).toBe(0));

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/edit');
    expect((opts.method as string).toUpperCase()).toBe('PUT');
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.expectedText).toBe('original');
    expect(body.newText).toBe('updated');
  });

  it('applyOne on 409 (stale_range) keeps the entry and does NOT clear it', async () => {
    mockFetch.mockImplementationOnce(() => makeEditStaleResponse('server version'));
    const { result } = renderHook(() => useEditBuffer(), { wrapper: Wrapper });
    const key = 'session/f.mdx:4:0';

    act(() => {
      result.current.setDirtyProse(key, {
        kind: 'prose',
        file: 'session/f.mdx',
        sourceStart: { line: 4, col: 0 },
        sourceEnd: { line: 4, col: 10 },
        originalText: 'old',
        currentText: 'new',
      });
    });

    await act(async () => {
      const success = await result.current.applyOne(key);
      expect(success).toBe(false);
    });

    // Entry must still be present after a 409.
    expect(result.current.dirtyCount).toBe(1);
    expect(result.current.entries.get(key)).toBeDefined();
  });

  it('applyAll applies all entries sequentially', async () => {
    mockFetch.mockImplementationOnce(makeEditOkResponse).mockImplementationOnce(makeEditOkResponse);

    const { result } = renderHook(() => useEditBuffer(), { wrapper: Wrapper });

    act(() => {
      result.current.setDirtyProse('k1', {
        kind: 'prose',
        file: 'f.mdx',
        sourceStart: { line: 1, col: 0 },
        sourceEnd: { line: 1, col: 3 },
        originalText: 'a',
        currentText: 'b',
      });
      result.current.setDirtyProse('k2', {
        kind: 'prose',
        file: 'f.mdx',
        sourceStart: { line: 2, col: 0 },
        sourceEnd: { line: 2, col: 3 },
        originalText: 'c',
        currentText: 'd',
      });
    });

    await act(async () => {
      await result.current.applyAll();
    });

    expect(result.current.dirtyCount).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('applyOne for a status entry calls PATCH /api/status', async () => {
    mockFetch.mockImplementationOnce(makeStatusOkResponse);
    const { result } = renderHook(() => useEditBuffer(), { wrapper: Wrapper });
    const key = 'status:session/phase.mdx:core';

    act(() => {
      result.current.setDirtyStatus(key, {
        kind: 'status',
        file: 'session/phase.mdx',
        phaseSlug: 'core',
        originalStatus: 'draft',
        currentStatus: 'in-progress',
      });
    });

    await act(async () => {
      await result.current.applyOne(key);
    });

    expect(result.current.dirtyCount).toBe(0);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/status');
    expect((opts.method as string).toUpperCase()).toBe('PATCH');
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.kind).toBe('phase-frontmatter');
    expect(body.newStatus).toBe('in-progress');
  });

  it('setDirtyProse updates currentText if key already exists', () => {
    const { result } = renderHook(() => useEditBuffer(), { wrapper: Wrapper });
    const key = 'session/f.mdx:1:0';
    const base = {
      kind: 'prose' as const,
      file: 'session/f.mdx',
      sourceStart: { line: 1, col: 0 },
      sourceEnd: { line: 1, col: 5 },
      originalText: 'original',
      currentText: 'v1',
    };

    act(() => {
      result.current.setDirtyProse(key, base);
    });
    act(() => {
      result.current.setDirtyProse(key, { ...base, currentText: 'v2' });
    });

    expect(result.current.dirtyCount).toBe(1);
    const entry = result.current.entries.get(key);
    expect(entry?.kind === 'prose' && entry.currentText).toBe('v2');
    // originalText must not be overwritten.
    expect(entry?.kind === 'prose' && entry.originalText).toBe('original');
  });

  it('diffMode toggle works', () => {
    const { result } = renderHook(() => useEditBuffer(), { wrapper: Wrapper });
    expect(result.current.diffMode).toBe(false);

    act(() => {
      result.current.setDiffMode(true);
    });

    expect(result.current.diffMode).toBe(true);
  });

  it('applyOne returns true without network call when key is not in buffer', async () => {
    const { result } = renderHook(() => useEditBuffer(), { wrapper: Wrapper });

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.applyOne('nonexistent-key');
    });

    expect(success).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
