import { describe, expect, it } from 'vitest';
import { parseFromWebview } from './messages.js';

describe('parseFromWebview', () => {
  it('parses openFile', () => {
    expect(parseFromWebview({ kind: 'openFile', path: 'src/a.ts' })).toEqual({
      kind: 'openFile',
      path: 'src/a.ts',
    });
  });

  it('rejects openFile without a string path', () => {
    expect(parseFromWebview({ kind: 'openFile' })).toBeUndefined();
    expect(parseFromWebview({ kind: 'openFile', path: 7 })).toBeUndefined();
  });

  it('parses openNativeDiff with and without reviewItemId', () => {
    expect(parseFromWebview({ kind: 'openNativeDiff', path: 'src/a.ts' })).toEqual({
      kind: 'openNativeDiff',
      path: 'src/a.ts',
    });
    expect(
      parseFromWebview({ kind: 'openNativeDiff', path: 'src/a.ts', reviewItemId: 'hunk-1' }),
    ).toEqual({ kind: 'openNativeDiff', path: 'src/a.ts', reviewItemId: 'hunk-1' });
  });

  it('rejects openNativeDiff with a non-string reviewItemId', () => {
    expect(
      parseFromWebview({ kind: 'openNativeDiff', path: 'src/a.ts', reviewItemId: 5 }),
    ).toBeUndefined();
  });

  it('parses setDiffVisible', () => {
    expect(parseFromWebview({ kind: 'setDiffVisible', value: false })).toEqual({
      kind: 'setDiffVisible',
      value: false,
    });
    expect(parseFromWebview({ kind: 'setDiffVisible', value: true })).toEqual({
      kind: 'setDiffVisible',
      value: true,
    });
  });

  it('rejects setDiffVisible without a boolean value', () => {
    expect(parseFromWebview({ kind: 'setDiffVisible' })).toBeUndefined();
    expect(parseFromWebview({ kind: 'setDiffVisible', value: 'yes' })).toBeUndefined();
  });

  it('parses advanceWalkthrough', () => {
    expect(
      parseFromWebview({ kind: 'advanceWalkthrough', groupId: 'group-1', reviewItemId: 'item-1' }),
    ).toEqual({ kind: 'advanceWalkthrough', groupId: 'group-1', reviewItemId: 'item-1' });
  });

  it('rejects advanceWalkthrough without string groupId/reviewItemId', () => {
    expect(parseFromWebview({ kind: 'advanceWalkthrough' })).toBeUndefined();
    expect(parseFromWebview({ kind: 'advanceWalkthrough', groupId: 'group-1' })).toBeUndefined();
    expect(
      parseFromWebview({ kind: 'advanceWalkthrough', groupId: 1, reviewItemId: 'item-1' }),
    ).toBeUndefined();
  });

  it('rejects unknown kinds and malformed payloads', () => {
    expect(parseFromWebview({ kind: 'nope' })).toBeUndefined();
    expect(parseFromWebview(null)).toBeUndefined();
    expect(parseFromWebview('openFile')).toBeUndefined();
  });
});
