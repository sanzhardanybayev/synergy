import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyCodeSections,
  buildScopeSnapshot,
  createQuestionQueue,
  createReviewStore,
  resolveReviewItemContext,
  resolveReviewLineSelection,
} from '../src/index.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'synergy-review-selection-'));
  const reference = { workspaceId: 'workspace-a', revisionId: 'revision-a' };
  const source = { kind: 'scope' as const, patterns: ['src'], headSha: 'abc123' };
  const snapshot = applyCodeSections(
    buildScopeSnapshot({
      revisionId: reference.revisionId,
      source,
      fingerprint: 'fingerprint-a',
      createdAt: '2026-07-19T10:00:00.000Z',
      files: [
        {
          path: 'src/example.ts',
          binary: false,
          lines: [
            { number: 1, text: 'export const first = true;' },
            { number: 2, text: 'export const second = true;' },
          ],
        },
      ],
    }),
    [{ path: 'src/example.ts', label: 'exports', start: 1, end: 2 }],
  );
  const item = snapshot.items[0]!;
  createReviewStore(root).createRevision(
    {
      schemaVersion: 1,
      id: reference.workspaceId,
      repository: { root, name: 'fixture' },
      source,
      currentRevisionId: reference.revisionId,
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    },
    snapshot,
    {
      schemaVersion: 1,
      revisionId: reference.revisionId,
      groups: [{ id: 'group-a', label: 'Group', reviewItemIds: [item.id] }],
      items: [
        {
          reviewItemId: item.id,
          description: 'Exports fixture values.',
          confidence: 'high',
          evidencePaths: [item.path],
        },
      ],
    },
    {
      schemaVersion: 1,
      updatedAt: '2026-07-19T10:00:00.000Z',
      items: { [item.id]: { status: 'needs-review' } },
    },
  );
  return { root, reference, snapshot, item };
}

describe('review question line selection', () => {
  it('persists and hydrates exact row ids with complete immutable item context', () => {
    const { root, reference, snapshot, item } = fixture();
    const itemContext = resolveReviewItemContext(snapshot, item.id);
    const selection = resolveReviewLineSelection(snapshot, item.id, [itemContext.rows[1]!.id]);
    const queue = createQuestionQueue(root, reference);

    const question = queue.enqueue({
      id: 'question-a',
      path: item.path,
      reviewItemId: item.id,
      selection,
      itemContext,
      description: 'Exports fixture values.',
      body: 'Why is the second export needed?',
      createdAt: '2026-07-19T10:00:00.000Z',
    });

    expect(question.selection).toEqual(selection);
    expect(question.itemContext).toEqual(itemContext);
    expect(
      createReviewStore(root).readBundle(reference.workspaceId, reference.revisionId).questions,
    ).toEqual([question]);
  });

  it('rejects persisted row ids or item context that do not match the immutable snapshot', () => {
    const { root, reference, snapshot, item } = fixture();
    const itemContext = resolveReviewItemContext(snapshot, item.id);
    const queue = createQuestionQueue(root, reference);
    queue.enqueue({
      id: 'question-a',
      path: item.path,
      reviewItemId: item.id,
      selection: { kind: 'scope', selectedLineIds: [itemContext.rows[0]!.id] },
      itemContext,
      description: 'Exports fixture values.',
      body: 'Why?',
      createdAt: '2026-07-19T10:00:00.000Z',
    });
    const envelopePath = join(
      root,
      '.synergy',
      'reviews',
      reference.workspaceId,
      'revisions',
      reference.revisionId,
      'questions',
      'question-a.json',
    );
    const envelope = JSON.parse(readFileSync(envelopePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      envelopePath,
      JSON.stringify({
        ...envelope,
        selection: { kind: 'scope', selectedLineIds: ['row-injected'] },
      }),
    );

    expect(() =>
      createReviewStore(root).readBundle(reference.workspaceId, reference.revisionId),
    ).toThrow(/review row|selection/i);
  });
});
