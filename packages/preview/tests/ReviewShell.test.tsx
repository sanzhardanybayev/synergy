import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDiffSnapshot } from '@synergy/review-core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ReviewProvider } from '../src/review/ReviewProvider.js';
import { ReviewShell } from '../src/review/ReviewShell.js';
import {
  REVIEW_REFERENCE,
  addedDiffRowId,
  makeDiffBundle,
  makeReviewClient,
  makeScopeBundle,
} from './review-ui-fixtures.js';

function renderShell(bundle = makeDiffBundle(), client = makeReviewClient(bundle)) {
  render(
    <ReviewProvider
      reference={{
        workspaceId: bundle.workspace.id,
        revisionId: bundle.snapshot.revisionId,
      }}
      client={client}
    >
      <ReviewShell />
    </ReviewProvider>,
  );
  return client;
}

describe('ReviewShell', () => {
  it('renders groups, files, the active hunk, and its repository-aware description', async () => {
    renderShell();
    expect(await screen.findByText('Theme and surfaces')).toBeVisible();
    expect(screen.getByText('features/plan/PlanCardToggle.tsx')).toBeVisible();
    expect(screen.getByText(/uses the nutrition-plan surface token/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeEnabled();
  });

  it('selects exact diff lines and sends them with a question', async () => {
    const user = userEvent.setup();
    const client = renderShell();
    await user.click(await screen.findByRole('button', { name: 'Select new line 17' }));
    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'Why this token?');
    await user.click(screen.getByRole('button', { name: 'Send question' }));
    expect(client.postQuestion).toHaveBeenCalledWith(
      REVIEW_REFERENCE,
      'hunk-theme',
      [addedDiffRowId()],
      'Why this token?',
      expect.any(AbortSignal),
    );
    expect(await screen.findByText('Question queued')).toBeVisible();
  });

  it('supports J/K navigation, R review toggle, and ? composer focus', async () => {
    const user = userEvent.setup();
    const client = renderShell();
    expect(await screen.findByRole('heading', { name: '@@ -17,1 +17,1 @@' })).toBeVisible();
    await user.keyboard('j');
    expect(screen.getByRole('heading', { name: '@@ -224,1 +224,2 @@' })).toBeVisible();
    await user.keyboard('r');
    await waitFor(() =>
      expect(client.patchProgress).toHaveBeenCalledWith(
        REVIEW_REFERENCE,
        'hunk-sheet',
        { status: 'reviewed' },
        expect.any(AbortSignal),
      ),
    );
    await user.keyboard('?');
    expect(screen.getByRole('textbox', { name: 'Question' })).toHaveFocus();
    await user.keyboard('k');
    expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('k');
  });

  it('ignores modified and repeated review shortcuts without blocking a plain R', async () => {
    const client = renderShell();
    await screen.findByRole('heading', { name: '@@ -17,1 +17,1 @@' });
    fireEvent.keyDown(window, { key: 'r', metaKey: true });
    fireEvent.keyDown(window, { key: 'r', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'r', altKey: true });
    fireEvent.keyDown(window, { key: 'r', repeat: true });
    expect(client.patchProgress).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'r' });
    await waitFor(() => expect(client.patchProgress).toHaveBeenCalledTimes(1));
  });

  it('shows full scoped source while selecting only canonical section rows', async () => {
    const user = userEvent.setup();
    renderShell(makeScopeBundle());
    expect(
      await screen.findByText("import { useQuery } from '@tanstack/react-query';"),
    ).toBeVisible();
    expect(screen.getByText('export const plan = true;')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Select source line 4' }));
    expect(screen.getByText('1 line selected')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Select source line 1' })).not.toBeInTheDocument();
  });

  it('shows and reviews zero-line file changes without offering line questions', async () => {
    const user = userEvent.setup();
    const base = makeDiffBundle();
    const snapshot = buildDiffSnapshot({
      revisionId: base.snapshot.revisionId,
      source: base.snapshot.source,
      fingerprint: 'mixed-ui-fingerprint',
      createdAt: base.snapshot.createdAt,
      patch: [
        'diff --git a/src/example.ts b/src/example.ts',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -1 +1 @@',
        '-before',
        '+after',
        'diff --git a/assets/logo.png b/assets/logo.png',
        'Binary files a/assets/logo.png and b/assets/logo.png differ',
      ].join('\n'),
    });
    const fileItem = snapshot.items.find((item) => item.kind === 'file');
    if (!fileItem) throw new Error('mixed UI fixture is missing its file-level item');
    const bundle = {
      ...base,
      snapshot,
      insights: {
        schemaVersion: 1 as const,
        revisionId: snapshot.revisionId,
        groups: [
          {
            id: 'mixed',
            label: 'Mixed changes',
            reviewItemIds: snapshot.items.map((item) => item.id),
          },
        ],
        items: snapshot.items.map((item) => ({
          reviewItemId: item.id,
          description: item.kind === 'file' ? 'Updates the binary logo asset.' : 'Updates code.',
          confidence: 'high' as const,
          evidencePaths: [item.path],
        })),
      },
      progress: {
        schemaVersion: 1 as const,
        updatedAt: base.progress.updatedAt,
        items: Object.fromEntries(
          snapshot.items.map((item) => [item.id, { status: 'needs-review' as const }]),
        ),
      },
    };
    const client = renderShell(bundle, makeReviewClient(bundle));

    expect(await screen.findByText('0/2')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /assets\/logo\.png/ }));
    expect(screen.getByRole('heading', { name: 'Binary file changed' })).toBeVisible();
    expect(screen.getByText(/no code lines to select/i)).toBeVisible();
    expect(screen.getByText(/line questions are unavailable/i)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Question' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    expect(client.patchProgress).toHaveBeenCalledWith(
      REVIEW_REFERENCE,
      fileItem.id,
      { status: 'reviewed' },
      expect.any(AbortSignal),
    );
  });

  it('shows a preparing state for an unfinalized empty scope instead of claiming no work', async () => {
    const pending = makeScopeBundle();
    if (pending.snapshot.kind !== 'scope') throw new Error('expected scoped fixture');
    pending.snapshot.items = [];
    pending.insights.groups = [];
    pending.insights.items = [];
    pending.progress.items = {};
    const client = makeReviewClient(pending, {
      getBundle: async () => ({
        bundle: pending,
        readiness: {
          ready: false,
          preparing: true,
          pending: 0,
          stale: 0,
          unanswered: 0,
          sourceChanged: false,
        },
        analysisFinalized: false,
      }),
    });

    renderShell(pending, client);

    expect(
      await screen.findByRole('heading', { name: /Preparing review analysis/i }),
    ).toBeVisible();
    expect(screen.queryByText('No reviewable items')).not.toBeInTheDocument();
  });

  it('gives immediate feedback when the file filter has no matches', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.type(await screen.findByRole('searchbox', { name: 'Find a file' }), 'missing-file');
    expect(screen.getByRole('status')).toHaveTextContent('No files match this filter.');
  });

  it('keeps revision, freshness, and progress facts in every responsive header', async () => {
    const reviewCss = readFileSync(resolve(process.cwd(), 'src/review/review.css'), 'utf8');
    renderShell();
    expect(await screen.findByText(REVIEW_REFERENCE.revisionId)).toBeVisible();
    expect(screen.getByText('Freshness')).toBeVisible();
    expect(screen.getByText('Progress')).toBeVisible();
    expect(reviewCss).toContain('@media (max-width: 1180px)');
    expect(reviewCss).toContain('@media (max-width: 900px)');
    expect(reviewCss).toContain('@media (max-width: 520px)');
    expect(reviewCss).not.toContain('.review-header__facts {\n    display: none;\n  }');
  });
});
