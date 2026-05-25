/**
 * Tests for UnloadGuard.
 *
 * Tests:
 *  - Dirty buffer: beforeunload handler is attached and calls e.preventDefault().
 *  - Clean buffer: no beforeunload handler attached.
 *
 * NOTE: useBlocker requires a data router. We use createMemoryRouter here.
 */

import { render } from '@testing-library/react';
import { useEffect } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditBufferProvider, useEditBuffer } from '../src/EditBuffer.js';
import { ToastProvider } from '../src/ToastProvider.js';
import { UnloadGuard } from '../src/UnloadGuard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function BufferDirtier() {
  // Depend on the stable setter, not the whole buffer object, so this runs once.
  const { setDirtyProse } = useEditBuffer();
  useEffect(() => {
    setDirtyProse('guard-test-key', {
      kind: 'prose',
      file: 'f.mdx',
      sourceStart: { line: 1, col: 0 },
      sourceEnd: { line: 1, col: 4 },
      originalText: 'old',
      currentText: 'new',
    });
  }, [setDirtyProse]);
  return null;
}

function makeRouter(dirty: boolean) {
  const route = {
    path: '/',
    element: (
      <ToastProvider>
        <EditBufferProvider>
          {dirty && <BufferDirtier />}
          <UnloadGuard />
        </EditBufferProvider>
      </ToastProvider>
    ),
  };
  return createMemoryRouter([route]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UnloadGuard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('registers a beforeunload listener when buffer is dirty', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');

    const router = makeRouter(true);
    render(<RouterProvider router={router} />);

    // Wait for effects (BufferDirtier sets dirty in useEffect).
    await vi.waitFor(() => {
      const calls = addSpy.mock.calls.filter((c) => c[0] === 'beforeunload');
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('removes the beforeunload listener on unmount', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const router = makeRouter(true);
    const { unmount } = render(<RouterProvider router={router} />);

    // Wait for dirty state to be set.
    await vi.waitFor(() => {
      expect(
        removeSpy.mock.calls.filter((c) => c[0] === 'beforeunload').length,
      ).toBeGreaterThanOrEqual(0);
    });

    unmount();

    const removedBeforeUnload = removeSpy.mock.calls.some((c) => c[0] === 'beforeunload');
    expect(removedBeforeUnload).toBe(true);
  });

  it('calls event.preventDefault() on beforeunload when buffer is dirty', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');

    const router = makeRouter(true);
    render(<RouterProvider router={router} />);

    // Wait for the handler to be registered.
    let handler: EventListener | undefined;
    await vi.waitFor(() => {
      const call = addSpy.mock.calls.find((c) => c[0] === 'beforeunload');
      expect(call).toBeDefined();
      handler = call![1] as EventListener;
    });

    const mockEvent = {
      preventDefault: vi.fn(),
      returnValue: '',
    } as unknown as BeforeUnloadEvent;

    handler!(mockEvent);

    expect(mockEvent.preventDefault).toHaveBeenCalled();
  });

  it('does NOT register a beforeunload listener when buffer is clean', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');

    const router = makeRouter(false);
    render(<RouterProvider router={router} />);

    const beforeUnloadCalls = addSpy.mock.calls.filter((c) => c[0] === 'beforeunload');
    expect(beforeUnloadCalls.length).toBe(0);
  });
});
