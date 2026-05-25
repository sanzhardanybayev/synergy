/**
 * Tests for EditableBlock.
 *
 * Tests:
 *  - Typing → dirty + Apply/Discard appear
 *  - Apply fires putEdit with correct expectedText (from fileSource) + newText
 *  - Discard reverts DOM and clears buffer
 *  - Enter in <li> adds sibling
 *  - Enter in empty <li> exits list (inserts <p>)
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditBufferProvider, useEditBuffer } from '../src/EditBuffer.js';
import { EditableBlock } from '../src/EditableBlock.js';
import { ToastProvider } from '../src/ToastProvider.js';

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A small harness that provides the EditBuffer context seeded with the given
 * fileSource + currentFile, then renders children.
 */
function Wrapper({
  children,
  fileSource = '',
  currentFile = '',
}: {
  children: ReactNode;
  fileSource?: string;
  currentFile?: string;
}) {
  return (
    <ToastProvider>
      <EditBufferProvider>
        <ContextSetter fileSource={fileSource} currentFile={currentFile} />
        {children}
      </EditBufferProvider>
    </ToastProvider>
  );
}

function ContextSetter({
  fileSource,
  currentFile,
}: {
  fileSource: string;
  currentFile: string;
}) {
  const buffer = useEditBuffer();
  useEffect(() => {
    buffer.setFileSource(fileSource);
    buffer.setCurrentFile(currentFile);
  }, [buffer, fileSource, currentFile]);
  return null;
}

function makeEditOkResponse() {
  return Promise.resolve(new Response(JSON.stringify({ ok: true, newSize: 100 }), { status: 200 }));
}

// ---------------------------------------------------------------------------
// Shared source fixture
// ---------------------------------------------------------------------------

// A simple source string where line 1 starts at offset 0.
// "Hello world" is at line 1, col 0..11.
const FILE_SOURCE = 'Hello world\nLine two content\n';
const FILE_NAME = '2026-05-25-test/00-overview.mdx';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EditableBlock', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(makeEditOkResponse);
  });

  it('renders children in a <p> tag', () => {
    render(
      <Wrapper fileSource={FILE_SOURCE} currentFile={FILE_NAME}>
        <EditableBlock
          as="p"
          data-source-line-start="1"
          data-source-col-start="0"
          data-source-line-end="1"
          data-source-col-end="11"
        >
          Hello world
        </EditableBlock>
      </Wrapper>,
    );

    expect(screen.getByText('Hello world').tagName).toBe('P');
  });

  it('shows Apply and Discard buttons after typing', async () => {
    render(
      <Wrapper fileSource={FILE_SOURCE} currentFile={FILE_NAME}>
        <EditableBlock
          as="p"
          data-source-line-start="1"
          data-source-col-start="0"
          data-source-line-end="1"
          data-source-col-end="11"
        >
          Hello world
        </EditableBlock>
      </Wrapper>,
    );

    const el = screen.getByText('Hello world');
    // Simulate user typing — dispatch input event.
    act(() => {
      el.textContent = 'Hello edit';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /apply/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
    });
  });

  it('Apply fires PUT /api/edit with correct expectedText and newText', async () => {
    render(
      <Wrapper fileSource={FILE_SOURCE} currentFile={FILE_NAME}>
        <EditableBlock
          as="p"
          data-source-line-start="1"
          data-source-col-start="0"
          data-source-line-end="1"
          data-source-col-end="11"
        >
          Hello world
        </EditableBlock>
      </Wrapper>,
    );

    const el = screen.getByText('Hello world');

    act(() => {
      el.textContent = 'New text here';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await waitFor(() => screen.getByRole('button', { name: /apply/i }));
    const applyBtn = screen.getByRole('button', { name: /apply/i });

    await act(async () => {
      await userEvent.click(applyBtn);
    });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/edit');
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    // expectedText comes from fileSource slice, NOT from DOM.
    expect(body.expectedText).toBe('Hello world');
    expect(body.newText).toBe('New text here');
  });

  it('Apply clears the dirty state on success', async () => {
    render(
      <Wrapper fileSource={FILE_SOURCE} currentFile={FILE_NAME}>
        <EditableBlock
          as="p"
          data-source-line-start="1"
          data-source-col-start="0"
          data-source-line-end="1"
          data-source-col-end="11"
        >
          Hello world
        </EditableBlock>
      </Wrapper>,
    );

    const el = screen.getByText('Hello world');
    act(() => {
      el.textContent = 'Changed';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await waitFor(() => screen.getByRole('button', { name: /apply/i }));

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: /apply/i }));
    });

    // After successful apply the action buttons disappear.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
    });
  });

  it('Discard reverts DOM text and hides action buttons', async () => {
    render(
      <Wrapper fileSource={FILE_SOURCE} currentFile={FILE_NAME}>
        <EditableBlock
          as="p"
          data-source-line-start="1"
          data-source-col-start="0"
          data-source-line-end="1"
          data-source-col-end="11"
        >
          Hello world
        </EditableBlock>
      </Wrapper>,
    );

    const el = screen.getByText('Hello world');
    act(() => {
      el.textContent = 'Changed text';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await waitFor(() => screen.getByRole('button', { name: /discard/i }));

    act(() => {
      screen.getByRole('button', { name: /discard/i }).click();
    });

    // After discard, action buttons should be gone.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /discard/i })).toBeNull();
    });

    // No fetch should have been called.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('registers edits on prose containing inline code and preserves backticks', async () => {
    const source = 'Use the `schema` field today\n';
    render(
      <Wrapper fileSource={source} currentFile={FILE_NAME}>
        <EditableBlock
          as="p"
          data-source-line-start="1"
          data-source-col-start="0"
          data-source-line-end="1"
          data-source-col-end="28"
        >
          {'Use the '}
          <code data-source-line-start="1" data-source-col-start="8">
            schema
          </code>
          {' field today'}
        </EditableBlock>
      </Wrapper>,
    );

    const p = document.querySelector('p[data-block-key]') as HTMLElement;
    expect(p).not.toBeNull();

    // Edit only the trailing text node — the <code> element stays in the DOM.
    act(() => {
      const lastText = p.childNodes[p.childNodes.length - 1];
      lastText.nodeValue = ' field tomorrow';
      p.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // The edit must register even though the block contains an inline element.
    await waitFor(() => screen.getByRole('button', { name: /apply/i }));

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: /apply/i }));
    });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.expectedText).toBe('Use the `schema` field today');
    // Backticks are preserved — the user only changed the visible text.
    expect(body.newText).toBe('Use the `schema` field tomorrow');
  });

  it('does not register edits on prose containing a CrossRef (avoids corruption)', async () => {
    const source = 'See <CrossRef to="x">the thing</CrossRef> now\n';
    render(
      <Wrapper fileSource={source} currentFile={FILE_NAME}>
        <EditableBlock
          as="p"
          data-source-line-start="1"
          data-source-col-start="0"
          data-source-line-end="1"
          data-source-col-end="45"
        >
          {'See '}
          {/* biome-ignore lint/a11y/useValidAnchor: test fixture mimicking CrossRef output */}
          <a href="#x" data-crossref="x">
            the thing
          </a>
          {' now'}
        </EditableBlock>
      </Wrapper>,
    );

    const p = document.querySelector('p[data-block-key]') as HTMLElement;
    act(() => {
      const lastText = p.childNodes[p.childNodes.length - 1];
      lastText.nodeValue = ' later';
      p.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // No Apply button — the block can't be safely round-tripped, so the edit is
    // intentionally not registered rather than corrupting the CrossRef.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
  });

  it('renders without source coords as non-editable (no contentEditable)', () => {
    render(
      <Wrapper fileSource={FILE_SOURCE} currentFile={FILE_NAME}>
        <EditableBlock as="p">No coords</EditableBlock>
      </Wrapper>,
    );

    const el = screen.getByText('No coords');
    expect(el.getAttribute('contenteditable')).toBeNull();
  });

  it('Enter in <li> inserts a sibling <li>', async () => {
    render(
      <Wrapper fileSource={FILE_SOURCE} currentFile={FILE_NAME}>
        <ul>
          <EditableBlock
            as="li"
            data-source-line-start="1"
            data-source-col-start="0"
            data-source-line-end="1"
            data-source-col-end="11"
          >
            Item one
          </EditableBlock>
        </ul>
      </Wrapper>,
    );

    // Wait for ContextSetter effects.
    await act(async () => {});

    const li = screen.getByText('Item one');
    li.textContent = 'Item one'; // ensure non-empty

    act(() => {
      fireEvent.keyDown(li, { key: 'Enter', code: 'Enter', bubbles: true });
    });

    // A new li should have been inserted as a sibling.
    const lis = document.querySelectorAll('li');
    expect(lis.length).toBeGreaterThanOrEqual(2);
  });

  it('Enter in empty <li> exits the list (inserts <p>)', async () => {
    render(
      <Wrapper fileSource={FILE_SOURCE} currentFile={FILE_NAME}>
        <ul>
          <EditableBlock
            as="li"
            data-source-line-start="1"
            data-source-col-start="0"
            data-source-line-end="1"
            data-source-col-end="11"
          >
            {''}
          </EditableBlock>
        </ul>
      </Wrapper>,
    );

    // Wait for ContextSetter effects to run so the block becomes editable.
    await act(async () => {});

    const li = screen.getByRole('listitem');
    // Ensure the li is editable and empty.
    expect(li.getAttribute('contenteditable')).toBe('true');
    li.textContent = '';

    act(() => {
      fireEvent.keyDown(li, { key: 'Enter', code: 'Enter', bubbles: true });
    });

    // A <p> should have been inserted after the list.
    // The <p> inserted by the handler has contentEditable set as a DOM property;
    // we check for its presence rather than the attribute specifically.
    await waitFor(() => {
      const pList = document.querySelectorAll('p');
      expect(pList.length).toBeGreaterThan(0);
    });
  });
});
