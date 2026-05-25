/**
 * Unit tests for commentAnchors.ts — pure string/coordinate math.
 * No DOM required.
 */

import { describe, expect, it } from 'vitest';
import type { CommentAnchor } from '../src/api.js';
import { computeAnchor, resolveAnchor } from '../src/commentAnchors.js';

// ---------------------------------------------------------------------------
// resolveAnchor
// ---------------------------------------------------------------------------

describe('resolveAnchor', () => {
  const source = [
    'line one text', // line 1
    'we sign users in via SSO and redirect them to the dashboard', // line 2
    'another line here', // line 3
  ].join('\n');

  it('returns exact match when line/col span equals selected', () => {
    // "SSO" starts at line 2, after "we sign users in via " (21 chars).
    // Line 2 starts at offset 14 (after "line one text\n").
    const anchor: CommentAnchor = {
      lineStart: 2,
      colStart: 21,
      lineEnd: 2,
      colEnd: 24,
      before: 'we sign users in via ',
      selected: 'SSO',
      after: ' and redirect',
    };

    const result = resolveAnchor(source, anchor);
    expect(result.kind).toBe('exact');
    if (result.kind === 'exact') {
      expect(source.slice(result.startOffset, result.endOffset)).toBe('SSO');
    }
  });

  it('returns context match when line/col has drifted but context is unique', () => {
    // Simulate drift: wrong line/col but unique context string.
    const anchor: CommentAnchor = {
      lineStart: 99, // Wrong — will throw in lineColToOffset
      colStart: 0,
      lineEnd: 99,
      colEnd: 3,
      before: 'we sign users in via ',
      selected: 'SSO',
      after: ' and redirect',
    };

    const result = resolveAnchor(source, anchor);
    expect(result.kind).toBe('context');
    if (result.kind === 'context') {
      expect(source.slice(result.startOffset, result.endOffset)).toBe('SSO');
    }
  });

  it('returns stale when line/col is wrong and context appears 0 times', () => {
    const anchor: CommentAnchor = {
      lineStart: 99,
      colStart: 0,
      lineEnd: 99,
      colEnd: 5,
      before: 'NONEXISTENT_BEFORE_',
      selected: 'GHOST',
      after: '_NONEXISTENT_AFTER',
    };

    const result = resolveAnchor(source, anchor);
    expect(result.kind).toBe('stale');
  });

  it('returns stale when context is ambiguous (appears more than once)', () => {
    // "line" appears in multiple source lines but "line one" is unique;
    // manufacture an ambiguous case.
    const ambiguousSource = 'abc def abc def\nabc def abc def';
    const anchor: CommentAnchor = {
      lineStart: 99,
      colStart: 0,
      lineEnd: 99,
      colEnd: 3,
      before: 'abc ',
      selected: 'def',
      after: ' abc',
    };

    // 'abc def abc' appears twice — findAnchor returns null → stale.
    const result = resolveAnchor(ambiguousSource, anchor);
    expect(result.kind).toBe('stale');
  });

  it('returns exact when selected text matches at the given span', () => {
    // Simple single-character selection at known position.
    const tiny = 'hello world';
    const anchor: CommentAnchor = {
      lineStart: 1,
      colStart: 6,
      lineEnd: 1,
      colEnd: 11,
      before: 'hello ',
      selected: 'world',
      after: '',
    };

    const result = resolveAnchor(tiny, anchor);
    expect(result.kind).toBe('exact');
  });
});

// ---------------------------------------------------------------------------
// computeAnchor
// ---------------------------------------------------------------------------

describe('computeAnchor', () => {
  it('produces correct line/col and context for a single-line block', () => {
    // Source has two lines; block is line 2.
    const fileSource = 'line one\nwe sign users in via SSO and more text here\nline three';
    // Block starts at line 2, col 0.
    // "SSO" is at offset 21 within the block text.
    const blockText = 'we sign users in via SSO and more text here';
    const selStart = 21; // offset of "SSO" in blockText
    const selEnd = 24;

    const anchor = computeAnchor(
      fileSource,
      { lineStart: 2, colStart: 0, lineEnd: 2, colEnd: blockText.length },
      selStart,
      selEnd,
      'SSO',
      blockText,
    );

    expect(anchor.selected).toBe('SSO');
    expect(anchor.lineStart).toBe(2);
    expect(anchor.colStart).toBe(21);
    expect(anchor.lineEnd).toBe(2);
    expect(anchor.colEnd).toBe(24);
    // before: up to 30 chars before selection in blockText
    expect(anchor.before).toBe('we sign users in via ');
    // after: up to 30 chars after selection
    expect(anchor.after).toBe(' and more text here');
  });

  it('trims before/after to 30 chars', () => {
    const longText = `${'a'.repeat(50)}TARGET${'b'.repeat(50)}`;
    const fileSource = longText;
    const selStart = 50;
    const selEnd = 56;

    const anchor = computeAnchor(
      fileSource,
      { lineStart: 1, colStart: 0, lineEnd: 1, colEnd: longText.length },
      selStart,
      selEnd,
      'TARGET',
      longText,
    );

    expect(anchor.before.length).toBe(30);
    expect(anchor.after.length).toBe(30);
    expect(anchor.selected).toBe('TARGET');
  });

  it('handles selection at the very start of the block (empty before)', () => {
    const text = 'Hello world';
    const fileSource = text;
    const anchor = computeAnchor(
      fileSource,
      { lineStart: 1, colStart: 0, lineEnd: 1, colEnd: text.length },
      0,
      5,
      'Hello',
      text,
    );

    expect(anchor.before).toBe('');
    expect(anchor.selected).toBe('Hello');
    expect(anchor.after).toBe(' world');
  });
});
