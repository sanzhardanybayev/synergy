import { describe, expect, it } from 'vitest';
import { findAnchor, lineColToOffset, offsetToLineCol } from '../../src/server/anchor.js';

describe('lineColToOffset', () => {
  const text = 'line one\nline two\nline three\n';

  it('resolves line 1 col 0 to offset 0', () => {
    expect(lineColToOffset(text, 1, 0)).toBe(0);
  });

  it('resolves line 2 col 0 to offset after first newline', () => {
    expect(lineColToOffset(text, 2, 0)).toBe(9);
  });

  it('resolves line 2 col 5 to correct offset', () => {
    expect(lineColToOffset(text, 2, 5)).toBe(14); // "line two" -> offset 9 + 5
  });

  it('resolves line 3 correctly', () => {
    expect(lineColToOffset(text, 3, 0)).toBe(18);
  });

  it('throws for line 0', () => {
    expect(() => lineColToOffset(text, 0, 0)).toThrow('line must be >= 1');
  });

  it('throws when line exceeds text', () => {
    expect(() => lineColToOffset(text, 100, 0)).toThrow();
  });

  it('throws when col is negative', () => {
    expect(() => lineColToOffset(text, 1, -1)).toThrow('col must be >= 0');
  });
});

describe('offsetToLineCol', () => {
  const text = 'line one\nline two\nline three\n';

  it('converts offset 0 to line 1 col 0', () => {
    expect(offsetToLineCol(text, 0)).toEqual({ line: 1, col: 0 });
  });

  it('converts offset after first newline to line 2 col 0', () => {
    expect(offsetToLineCol(text, 9)).toEqual({ line: 2, col: 0 });
  });

  it('round-trips with lineColToOffset', () => {
    const pairs: Array<[number, number]> = [
      [1, 0],
      [1, 4],
      [2, 0],
      [2, 4],
      [3, 3],
    ];
    for (const [line, col] of pairs) {
      const offset = lineColToOffset(text, line, col);
      expect(offsetToLineCol(text, offset)).toEqual({ line, col });
    }
  });

  it('throws for negative offset', () => {
    expect(() => offsetToLineCol(text, -1)).toThrow();
  });

  it('throws for offset beyond text length', () => {
    expect(() => offsetToLineCol(text, text.length + 1)).toThrow();
  });
});

describe('findAnchor', () => {
  const text = 'we sign users in via SSO and redirect them to the dashboard.';

  it('finds unique match and returns correct start/end', () => {
    const result = findAnchor(text, {
      before: 'sign users in via ',
      selected: 'SSO',
      after: ' and redirect',
    });
    expect(result).not.toBeNull();
    expect(result!.start).toBe(text.indexOf('SSO'));
    expect(result!.end).toBe(text.indexOf('SSO') + 3);
  });

  it('returns null when pattern is not found', () => {
    const result = findAnchor(text, {
      before: 'NOBODY',
      selected: 'HERE',
      after: 'EITHER',
    });
    expect(result).toBeNull();
  });

  it('returns null when pattern matches more than once (ambiguous)', () => {
    const repeated = 'foo bar baz foo bar baz';
    const result = findAnchor(repeated, {
      before: 'foo ',
      selected: 'bar',
      after: ' baz',
    });
    expect(result).toBeNull();
  });

  it('matches empty before/after (selected at start of text)', () => {
    const result = findAnchor('hello world', {
      before: '',
      selected: 'hello',
      after: ' world',
    });
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(5);
  });
});
