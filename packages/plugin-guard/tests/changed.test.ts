import { describe, expect, it } from 'vitest';
import { requiresBump } from '../src/changed.js';
import { shouldFail } from '../src/check-bump.js';

describe('requiresBump', () => {
  it('is true when a behavior dir changed', () => {
    expect(requiresBump(['skills/create-spec/SKILL.md'])).toBe(true);
    expect(requiresBump(['packages/spec-kit/src/x.ts'])).toBe(true);
    expect(requiresBump(['commands/foo.md'])).toBe(true);
    expect(requiresBump(['hooks/session-start.sh'])).toBe(true);
  });
  it('is false for non-behavioral changes only', () => {
    expect(requiresBump(['docs/x.md', 'examples/y.mdx', 'README.md'])).toBe(false);
    expect(requiresBump([])).toBe(false);
  });
  it('is true when behavior + non-behavior changes are mixed', () => {
    expect(requiresBump(['docs/x.md', 'skills/execute/SKILL.md'])).toBe(true);
  });
});

describe('shouldFail', () => {
  const base = '0.6.0';
  it('fails when a behavior dir changed but version did not increase', () => {
    expect(
      shouldFail({ baseVersion: base, headVersion: '0.6.0', changedPaths: ['skills/x/SKILL.md'] })
        .fail,
    ).toBe(true);
  });
  it('passes when the version increased', () => {
    expect(
      shouldFail({ baseVersion: base, headVersion: '0.7.0', changedPaths: ['skills/x/SKILL.md'] })
        .fail,
    ).toBe(false);
  });
  it('passes when only non-behavioral files changed', () => {
    expect(
      shouldFail({ baseVersion: base, headVersion: '0.6.0', changedPaths: ['docs/x.md'] }).fail,
    ).toBe(false);
  });
});
