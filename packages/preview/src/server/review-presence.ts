import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ReviewRef,
  assertSafeReviewSegment,
  reviewQuestionsDirectory,
} from '@synergy/review-core';

export const REVIEW_LISTENER_STALE_MS = 90_000;

export interface ReviewListenerPresence {
  listening: boolean;
  nextExpiryAt?: number;
}

function parseListenerRecord(
  directory: string,
  filename: string,
  now: number,
): { expiresAt: number } | undefined {
  if (!filename.endsWith('.json')) return undefined;
  const filenameId = filename.slice(0, -'.json'.length);
  try {
    assertSafeReviewSegment(filenameId, 'listener');
    const value: unknown = JSON.parse(readFileSync(join(directory, filename), 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const keys = Object.keys(value);
    if (keys.length !== 2 || !keys.includes('listenerId') || !keys.includes('updatedAt')) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (record.listenerId !== filenameId || typeof record.updatedAt !== 'string') return undefined;
    const updatedAt = Date.parse(record.updatedAt);
    if (
      !Number.isFinite(updatedAt) ||
      new Date(updatedAt).toISOString() !== record.updatedAt ||
      updatedAt > now
    ) {
      return undefined;
    }
    return { expiresAt: updatedAt + REVIEW_LISTENER_STALE_MS };
  } catch {
    return undefined;
  }
}

/** Reads only schema-valid listener heartbeats for one exact immutable revision. */
export function readReviewListenerPresence(
  projectRoot: string,
  reference: ReviewRef,
  now: number,
): ReviewListenerPresence {
  const directory = join(reviewQuestionsDirectory(projectRoot, reference), '.listeners');
  try {
    const activeExpiries = readdirSync(directory)
      .map((filename) => parseListenerRecord(directory, filename, now)?.expiresAt)
      .filter((expiresAt): expiresAt is number => expiresAt !== undefined && expiresAt > now);
    if (activeExpiries.length === 0) return { listening: false };
    return { listening: true, nextExpiryAt: Math.min(...activeExpiries) };
  } catch {
    return { listening: false };
  }
}
