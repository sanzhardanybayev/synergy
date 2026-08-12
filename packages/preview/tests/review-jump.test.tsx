import { buildDiffSnapshot } from '@synergy/review-core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewProvider } from '../src/review/ReviewProvider.js';
import { ReviewShell } from '../src/review/ReviewShell.js';
import { makeDiffBundle, makeReviewClient } from './review-ui-fixtures.js';

/**
 * A two-file diff where `src/auth/session.ts` removes a run whose rationale resolves onto
 * `src/http/interceptor.ts`'s added lines - the exact shape a `moved` removal jump needs.
 */
function makeRemovalJumpBundle() {
  const base = makeDiffBundle();
  const snapshot = buildDiffSnapshot({
    revisionId: base.snapshot.revisionId,
    source: base.snapshot.source,
    fingerprint: 'removal-jump-fingerprint',
    createdAt: base.snapshot.createdAt,
    patch: [
      'diff --git a/src/auth/session.ts b/src/auth/session.ts',
      '--- a/src/auth/session.ts',
      '+++ b/src/auth/session.ts',
      '@@ -40,4 +40,2 @@',
      ' const before = true;',
      '-function refreshToken() {',
      '-  return legacyRefresh();',
      ' const after = true;',
      'diff --git a/src/http/interceptor.ts b/src/http/interceptor.ts',
      '--- a/src/http/interceptor.ts',
      '+++ b/src/http/interceptor.ts',
      '@@ -87,2 +87,4 @@',
      ' const before = true;',
      '+function refreshToken() {',
      '+  return legacyRefresh();',
      ' const after = true;',
    ].join('\n'),
  });
  const [sessionItem, interceptorItem] = snapshot.items;
  if (!sessionItem || !interceptorItem) throw new Error('fixture must produce two review items');
  const bundle = {
    ...base,
    snapshot,
    insights: {
      schemaVersion: 1 as const,
      revisionId: snapshot.revisionId,
      groups: [
        {
          id: 'auth',
          label: 'Auth cleanup',
          reviewItemIds: [sessionItem.id, interceptorItem.id],
        },
      ],
      items: [
        {
          reviewItemId: sessionItem.id,
          description: 'Drops the local refresh helper.',
          confidence: 'high' as const,
          evidencePaths: [sessionItem.path],
        },
        {
          reviewItemId: interceptorItem.id,
          description: 'Adds the refresh helper to the interceptor.',
          confidence: 'high' as const,
          evidencePaths: [interceptorItem.path],
        },
      ],
      removals: [
        {
          reviewItemId: sessionItem.id,
          run: { path: sessionItem.path, start: 41, end: 42 },
          reason: 'moved' as const,
          description: 'Refresh converged into the interceptor.',
          movedTo: { path: interceptorItem.path, start: 88, end: 89 },
        },
      ],
    },
    progress: {
      schemaVersion: 1 as const,
      updatedAt: base.progress.updatedAt,
      items: {
        [sessionItem.id]: { status: 'needs-review' as const },
        [interceptorItem.id]: { status: 'needs-review' as const },
      },
    },
  };
  return { bundle, sessionItem, interceptorItem };
}

function renderReviewAt() {
  const { bundle, sessionItem, interceptorItem } = makeRemovalJumpBundle();
  const client = makeReviewClient(bundle);
  render(
    <ReviewProvider
      reference={{ workspaceId: bundle.workspace.id, revisionId: bundle.snapshot.revisionId }}
      client={client}
    >
      <ReviewShell />
    </ReviewProvider>,
  );
  return { client, sessionItem, interceptorItem };
}

describe('removal jump navigation', () => {
  beforeEach(() => {
    // Expansion preference is localStorage-backed and keyed by revision id, which every fixture
    // here shares - clear it so one test's expand-all doesn't leak into the next.
    localStorage.clear();
  });

  it('jumping sets the active item, flashes the target rows, and offers a way back', async () => {
    const user = userEvent.setup();
    renderReviewAt();
    await user.click(
      await screen.findByRole('button', { name: /→ src\/http\/interceptor\.ts:88/ }),
    );
    expect(
      await screen.findByRole('region', { name: 'File src/http/interceptor.ts' }),
    ).toBeVisible();
    expect(document.querySelector('.review-code-row.is-flashed')).toBeTruthy();
    expect(screen.getByRole('button', { name: /back to src\/auth\/session\.ts:41/i })).toBeTruthy();
  });

  it('jumping does not change any review status or persist walkthrough progress', async () => {
    const user = userEvent.setup();
    const { client } = renderReviewAt();
    await user.click(
      await screen.findByRole('button', { name: /→ src\/http\/interceptor\.ts:88/ }),
    );
    expect(client.patchProgress).not.toHaveBeenCalled();
    // A jump touches only the LOCAL reveal floor - it must never advance the persisted
    // walkthrough cursor (activeGroupId/activeReviewItemId), which is monotonic server state a
    // later "back" jump could not undo.
    expect(client.patchWalkthrough).not.toHaveBeenCalled();
  });

  it('jumping scrolls the stage into view', async () => {
    // jsdom has no layout engine and doesn't implement scrollIntoView at all.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const user = userEvent.setup();
    renderReviewAt();
    await user.click(
      await screen.findByRole('button', { name: /→ src\/http\/interceptor\.ts:88/ }),
    );
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
  });

  it('the back chip returns to the origin item and clears itself', async () => {
    const user = userEvent.setup();
    renderReviewAt();
    await user.click(
      await screen.findByRole('button', { name: /→ src\/http\/interceptor\.ts:88/ }),
    );
    await user.click(
      await screen.findByRole('button', { name: /back to src\/auth\/session\.ts:41/i }),
    );
    expect(await screen.findByRole('region', { name: 'File src/auth/session.ts' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /back to src\/auth\/session\.ts:41/i }),
    ).not.toBeInTheDocument();
  });

  it('expand all opens every strip and collapse all closes them', async () => {
    const user = userEvent.setup();
    renderReviewAt();
    await user.click(await screen.findByRole('button', { name: /expand all/i }));
    expect(screen.getAllByText(/converged into the interceptor/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /collapse all/i }));
    expect(screen.queryByText(/converged into the interceptor/)).toBeNull();
  });
});
