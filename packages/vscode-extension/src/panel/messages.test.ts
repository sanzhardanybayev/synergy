import { describe, expect, it } from 'vitest';
import { parseFromWebview } from './messages.js';

describe('parseFromWebview', () => {
  it('parses a valid ready message', () => {
    expect(parseFromWebview({ kind: 'ready' })).toEqual({ kind: 'ready' });
  });

  it('parses a valid backToSessions message', () => {
    expect(parseFromWebview({ kind: 'backToSessions' })).toEqual({ kind: 'backToSessions' });
  });

  it('parses a valid openSession message', () => {
    expect(parseFromWebview({ kind: 'openSession', workspaceId: 'w1', revisionId: 'r1' })).toEqual({
      kind: 'openSession',
      workspaceId: 'w1',
      revisionId: 'r1',
    });
  });

  it('parses a valid openHunk message', () => {
    expect(parseFromWebview({ kind: 'openHunk', reviewItemId: 'x' })).toEqual({
      kind: 'openHunk',
      reviewItemId: 'x',
    });
  });

  it('parses a valid setStatus message', () => {
    expect(parseFromWebview({ kind: 'setStatus', reviewItemId: 'x', status: 'reviewed' })).toEqual({
      kind: 'setStatus',
      reviewItemId: 'x',
      status: 'reviewed',
    });
  });

  it('parses a valid saveNote message', () => {
    expect(parseFromWebview({ kind: 'saveNote', reviewItemId: 'x', note: 'hello' })).toEqual({
      kind: 'saveNote',
      reviewItemId: 'x',
      note: 'hello',
    });
  });

  it('parses a valid openNativeDiff message', () => {
    expect(parseFromWebview({ kind: 'openNativeDiff', path: 'a/b.ts' })).toEqual({
      kind: 'openNativeDiff',
      path: 'a/b.ts',
    });
  });

  it('parses a valid showSnapshot message', () => {
    expect(parseFromWebview({ kind: 'showSnapshot', path: 'a/b.ts' })).toEqual({
      kind: 'showSnapshot',
      path: 'a/b.ts',
    });
  });

  it('rejects unknown kinds', () => {
    expect(parseFromWebview({ kind: 'nope' })).toBeUndefined();
  });

  it('rejects malformed payloads', () => {
    expect(parseFromWebview({ kind: 'setStatus', reviewItemId: 1 })).toBeUndefined();
    expect(
      parseFromWebview({ kind: 'setStatus', reviewItemId: 'x', status: 'bogus' }),
    ).toBeUndefined();
    expect(parseFromWebview({ kind: 'openSession', workspaceId: 'w1' })).toBeUndefined();
    expect(parseFromWebview({ kind: 'openHunk' })).toBeUndefined();
    expect(parseFromWebview({ kind: 'saveNote', reviewItemId: 'x', note: 5 })).toBeUndefined();
    expect(parseFromWebview({ kind: 'openNativeDiff', path: 5 })).toBeUndefined();
  });

  it('rejects non-object and non-string-kind values', () => {
    expect(parseFromWebview(null)).toBeUndefined();
    expect(parseFromWebview(undefined)).toBeUndefined();
    expect(parseFromWebview('ready')).toBeUndefined();
    expect(parseFromWebview({})).toBeUndefined();
    expect(parseFromWebview({ kind: 5 })).toBeUndefined();
  });
});
