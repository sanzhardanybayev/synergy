/**
 * Tests for commentDom.ts — anchor → DOM range mapping.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Comment } from '../src/api.js';
import {
  createRangeInBlock,
  findBlockForOffset,
  getBlockSourceSpan,
  locateCommentInDom,
} from '../src/commentDom.js';

function makeComment(anchor: Comment['anchor']): Comment {
  return {
    id: 'test-comment',
    session: '2026-05-25-sess',
    file: '00-overview.mdx',
    status: 'open',
    created: '2026-05-25T09:00:00Z',
    anchor,
    body: 'Test note',
  };
}

describe('commentDom', () => {
  let mdxBody: HTMLElement;
  const fileSource = 'we sign users in via SSO and redirect them to the dashboard';

  beforeEach(() => {
    document.body.innerHTML = `
      <div class="mdx-body">
        <p
          data-source-line-start="1"
          data-source-col-start="0"
          data-source-line-end="1"
          data-source-col-end="${fileSource.length}"
        >${fileSource}</p>
      </div>
    `;
    mdxBody = document.querySelector('.mdx-body') as HTMLElement;
  });

  it('getBlockSourceSpan returns file offsets for an annotated block', () => {
    const block = mdxBody.querySelector('p')!;
    expect(getBlockSourceSpan(fileSource, block)).toEqual({ start: 0, end: fileSource.length });
  });

  it('findBlockForOffset locates the block containing an offset', () => {
    const block = findBlockForOffset(mdxBody, fileSource, 25);
    expect(block?.tagName).toBe('P');
  });

  it('createRangeInBlock selects SSO in the paragraph', () => {
    const block = mdxBody.querySelector('p')!;
    const start = fileSource.indexOf('SSO');
    const end = start + 3;
    const range = createRangeInBlock(block, start, end);
    expect(range?.toString()).toBe('SSO');
  });

  it('locateCommentInDom returns exact match with a live range', () => {
    const start = fileSource.indexOf('SSO');
    const comment = makeComment({
      lineStart: 1,
      colStart: start,
      lineEnd: 1,
      colEnd: start + 3,
      before: 'we sign users in via ',
      selected: 'SSO',
      after: ' and redirect',
    });

    const located = locateCommentInDom(mdxBody, fileSource, comment);
    expect(located.kind).toBe('exact');
    expect(located.range?.toString()).toBe('SSO');
  });

  it('locateCommentInDom returns stale when context cannot be found', () => {
    const comment = makeComment({
      lineStart: 1,
      colStart: 0,
      lineEnd: 1,
      colEnd: 3,
      before: 'missing',
      selected: 'xyz',
      after: 'context',
    });

    const located = locateCommentInDom(mdxBody, fileSource, comment);
    expect(located.kind).toBe('stale');
    expect(located.range).toBeNull();
  });
});
