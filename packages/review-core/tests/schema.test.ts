import { describe, expect, it } from 'vitest';
import { assertReviewInsights } from '../src/index.js';

describe('assertReviewInsights narrative fields', () => {
  it('accepts insights with optional summary and group intro', () => {
    const insights = {
      schemaVersion: 1,
      revisionId: 'rev-1',
      summary: 'The story of this change.',
      groups: [{ id: 'core', label: 'Core', intro: 'Start here.', reviewItemIds: ['item-1'] }],
      items: [
        {
          reviewItemId: 'item-1',
          description: 'Does a thing.',
          confidence: 'high',
          evidencePaths: ['src/a.ts'],
        },
      ],
    };
    expect(() => assertReviewInsights(insights)).not.toThrow();
  });

  it('still accepts insights without narrative fields', () => {
    const insights = {
      schemaVersion: 1,
      revisionId: 'rev-1',
      groups: [{ id: 'core', label: 'Core', reviewItemIds: ['item-1'] }],
      items: [
        {
          reviewItemId: 'item-1',
          description: 'Does a thing.',
          confidence: 'high',
          evidencePaths: ['src/a.ts'],
        },
      ],
    };
    expect(() => assertReviewInsights(insights)).not.toThrow();
  });

  it('rejects a blank summary', () => {
    const insights = {
      schemaVersion: 1,
      revisionId: 'rev-1',
      summary: '',
      groups: [{ id: 'core', label: 'Core', reviewItemIds: ['item-1'] }],
      items: [
        {
          reviewItemId: 'item-1',
          description: 'Does a thing.',
          confidence: 'high',
          evidencePaths: ['src/a.ts'],
        },
      ],
    };
    expect(() => assertReviewInsights(insights)).toThrow();
  });
});
