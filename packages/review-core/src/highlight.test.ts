import { describe, expect, it } from 'vitest';
import {
  type HighlightedLine,
  emberGraphiteTheme,
  highlightHunk,
  highlightLines,
  resolveLanguage,
} from './highlight.js';

/** Tokens must always reassemble into the exact input line - highlighting is presentation only. */
function lineText(line: HighlightedLine): string {
  return line.map((token) => token.text).join('');
}

describe('resolveLanguage', () => {
  it('maps supported extensions case-insensitively', () => {
    expect(resolveLanguage('packages/preview/src/review/DiffViewer.tsx')).toBe('tsx');
    expect(resolveLanguage('src/server/review-api.ts')).toBe('typescript');
    expect(resolveLanguage('scripts/build.MJS')).toBe('javascript');
    expect(resolveLanguage('a/b/theme.css')).toBe('css');
    expect(resolveLanguage('docs/design.md')).toBe('markdown');
  });

  it('recognizes extensionless files by basename', () => {
    expect(resolveLanguage('Dockerfile')).toBe('docker');
    expect(resolveLanguage('deep/path/Makefile')).toBe('make');
  });

  it('returns undefined for unknown or extensionless paths', () => {
    expect(resolveLanguage('LICENSE')).toBeUndefined();
    expect(resolveLanguage('assets/logo.psd')).toBeUndefined();
    expect(resolveLanguage('')).toBeUndefined();
  });
});

describe('emberGraphiteTheme', () => {
  it('produces a distinct registration per mode with a transparent background', () => {
    const light = emberGraphiteTheme('light');
    const dark = emberGraphiteTheme('dark');
    expect(light.name).not.toBe(dark.name);
    expect(light.type).toBe('light');
    expect(dark.type).toBe('dark');
    expect(light.colors?.['editor.background']).toBe('#00000000');
    expect(dark.colors?.['editor.background']).toBe('#00000000');
  });
});

describe('highlightLines', () => {
  it('returns one entry per line and preserves the source text exactly', async () => {
    const code = [
      'const answer = 42;',
      '',
      'export function id<T>(value: T): T {',
      '  return value;',
      '}',
    ].join('\n');
    const lines = await highlightLines(code, 'typescript', 'dark');
    expect(lines).toHaveLength(5);
    expect(lines.map(lineText)).toEqual(code.split('\n'));
  });

  it('actually assigns colors rather than returning a single bare token', async () => {
    const [line] = await highlightLines('const x = "hi";', 'typescript', 'light');
    expect(line!.length).toBeGreaterThan(1);
    expect(line!.some((token) => token.color !== undefined)).toBe(true);
  });

  it('carries block-comment state across lines', async () => {
    const code = ['/*', ' const notCode = 1;', ' */', 'const real = 1;'].join('\n');
    const lines = await highlightLines(code, 'typescript', 'light');
    const commentColor = lines[0]![0]!.color;
    expect(lines[1]!.every((token) => token.color === commentColor)).toBe(true);
    expect(lines[3]!.some((token) => token.color !== commentColor)).toBe(true);
  });

  it('falls back to a single plain token for an unsupported language', async () => {
    const lines = await highlightLines('a\nb', 'not-a-language', 'light');
    expect(lines.map(lineText)).toEqual(['a', 'b']);
    expect(lines.every((line) => line.every((token) => token.color === undefined))).toBe(true);
  });

  it('falls back to plain lines past the size ceiling', async () => {
    const huge = `${'x'.repeat(600_000)}\ny`;
    const lines = await highlightLines(huge, 'typescript', 'light');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveLength(1);
    expect(lines[0]![0]!.color).toBeUndefined();
  });
});

describe('highlightHunk', () => {
  const rows = [
    { kind: 'context' as const, text: '/*' },
    { kind: 'remove' as const, text: ' old comment line' },
    { kind: 'add' as const, text: ' new comment line' },
    { kind: 'context' as const, text: ' */' },
    { kind: 'context' as const, text: 'const after = 1;' },
  ];

  it('returns one entry per row, preserving each row text', async () => {
    const lines = await highlightHunk(rows, 'typescript', 'light');
    expect(lines).toHaveLength(rows.length);
    expect(lines.map(lineText)).toEqual(rows.map((row) => row.text));
  });

  it('tokenizes each side with its own comment state', async () => {
    const lines = await highlightHunk(rows, 'typescript', 'light');
    const commentColor = lines[0]![0]!.color;
    // Both the removed and the added line sit inside the block comment on their own side.
    expect(lines[1]!.every((token) => token.color === commentColor)).toBe(true);
    expect(lines[2]!.every((token) => token.color === commentColor)).toBe(true);
    // The line after the comment closes is not comment-colored on either side.
    expect(lines[4]!.some((token) => token.color !== commentColor)).toBe(true);
  });

  it('falls back to plain rows for an unsupported language', async () => {
    const lines = await highlightHunk(rows, undefined, 'dark');
    expect(lines.map(lineText)).toEqual(rows.map((row) => row.text));
    expect(lines.every((line) => line.every((token) => token.color === undefined))).toBe(true);
  });

  it('handles a hunk with no context lines', async () => {
    const lines = await highlightHunk(
      [
        { kind: 'remove', text: 'const a = 1;' },
        { kind: 'add', text: 'const b = 2;' },
      ],
      'typescript',
      'light',
    );
    expect(lines.map(lineText)).toEqual(['const a = 1;', 'const b = 2;']);
    expect(lines.every((line) => line.some((token) => token.color !== undefined))).toBe(true);
  });
});
