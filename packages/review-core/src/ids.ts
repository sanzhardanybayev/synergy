import type { ReviewRef } from './types.js';

export const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

export function assertSafeReviewSegment(
  value: string,
  label: 'workspace' | 'revision' | 'question' | 'answer' | 'listener' | 'claim token',
): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`invalid review ${label}`);
  }
}

export function formatReviewRef(workspaceId: string, revisionId: string): string {
  assertSafeReviewSegment(workspaceId, 'workspace');
  assertSafeReviewSegment(revisionId, 'revision');
  return `${workspaceId}@${revisionId}`;
}

export function parseReviewRef(value: string): ReviewRef {
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('review reference must be <workspace>@<revision>');
  }
  const workspaceId = value.slice(0, separator);
  const revisionId = value.slice(separator + 1);
  assertSafeReviewSegment(workspaceId, 'workspace');
  assertSafeReviewSegment(revisionId, 'revision');
  return { workspaceId, revisionId };
}
