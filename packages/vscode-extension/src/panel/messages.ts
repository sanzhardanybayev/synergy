import type { ReviewBundle } from '@synergy/review-core';
import type { DriftState } from '../data/drift.js';
import type { SessionSummary } from '../data/sessions.js';

/**
 * `ReviewBundle` plus the per-file drift computed against the current working tree, and the
 * project root the paths are relative to. Assembled by `serializeBundle` (see `serialize.ts`).
 */
export interface SerializedBundle {
  bundle: ReviewBundle;
  drift: Record<string, DriftState>;
  projectRoot: string;
}

export type ToWebview =
  | { kind: 'sessions'; sessions: SessionSummary[] }
  | { kind: 'bundle'; bundle: SerializedBundle }
  | { kind: 'error'; message: string };

export type FromWebview =
  | { kind: 'ready' }
  | { kind: 'openSession'; workspaceId: string; revisionId: string }
  | { kind: 'openHunk'; reviewItemId: string }
  | { kind: 'setStatus'; reviewItemId: string; status: 'reviewed' | 'needs-review' }
  | { kind: 'setStatusBatch'; reviewItemIds: string[]; status: 'reviewed' | 'needs-review' }
  | { kind: 'saveNote'; reviewItemId: string; note: string }
  | { kind: 'backToSessions' }
  | { kind: 'openNativeDiff'; path: string; reviewItemId?: string }
  | { kind: 'showSnapshot'; path: string }
  | { kind: 'openFile'; path: string; line?: number }
  | { kind: 'setDiffVisible'; value: boolean }
  | { kind: 'advanceWalkthrough'; groupId: string; reviewItemId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validates a raw postMessage payload from the webview against the `FromWebview` protocol.
 * Returns `undefined` for anything malformed rather than throwing, so a single bad message from
 * an out-of-sync webview never crashes the extension host.
 */
export function parseFromWebview(value: unknown): FromWebview | undefined {
  if (!isRecord(value) || !isString(value.kind)) return undefined;

  switch (value.kind) {
    case 'ready':
      return { kind: 'ready' };

    case 'backToSessions':
      return { kind: 'backToSessions' };

    case 'openSession':
      if (isString(value.workspaceId) && isString(value.revisionId)) {
        return {
          kind: 'openSession',
          workspaceId: value.workspaceId,
          revisionId: value.revisionId,
        };
      }
      return undefined;

    case 'openHunk':
      if (isString(value.reviewItemId)) {
        return { kind: 'openHunk', reviewItemId: value.reviewItemId };
      }
      return undefined;

    case 'setStatus':
      if (
        isString(value.reviewItemId) &&
        (value.status === 'reviewed' || value.status === 'needs-review')
      ) {
        return { kind: 'setStatus', reviewItemId: value.reviewItemId, status: value.status };
      }
      return undefined;

    case 'setStatusBatch':
      if (
        isStringArray(value.reviewItemIds) &&
        (value.status === 'reviewed' || value.status === 'needs-review')
      ) {
        return {
          kind: 'setStatusBatch',
          reviewItemIds: value.reviewItemIds,
          status: value.status,
        };
      }
      return undefined;

    case 'saveNote':
      if (isString(value.reviewItemId) && isString(value.note)) {
        return { kind: 'saveNote', reviewItemId: value.reviewItemId, note: value.note };
      }
      return undefined;

    case 'openNativeDiff':
      if (
        isString(value.path) &&
        (value.reviewItemId === undefined || isString(value.reviewItemId))
      ) {
        return value.reviewItemId === undefined
          ? { kind: 'openNativeDiff', path: value.path }
          : { kind: 'openNativeDiff', path: value.path, reviewItemId: value.reviewItemId };
      }
      return undefined;

    case 'openFile':
      if (isString(value.path) && (value.line === undefined || isNumber(value.line))) {
        return value.line === undefined
          ? { kind: 'openFile', path: value.path }
          : { kind: 'openFile', path: value.path, line: value.line };
      }
      return undefined;

    case 'setDiffVisible':
      if (typeof value.value === 'boolean') {
        return { kind: 'setDiffVisible', value: value.value };
      }
      return undefined;

    case 'showSnapshot':
      if (isString(value.path)) {
        return { kind: 'showSnapshot', path: value.path };
      }
      return undefined;

    case 'advanceWalkthrough':
      if (isString(value.groupId) && isString(value.reviewItemId)) {
        return {
          kind: 'advanceWalkthrough',
          groupId: value.groupId,
          reviewItemId: value.reviewItemId,
        };
      }
      return undefined;

    default:
      return undefined;
  }
}
