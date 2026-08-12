import type { ReviewBundle, ReviewFileInsight, ReviewItem } from '@synergy/review-core';
import {
  type RemovalStrip as RemovalStripModel,
  type ResolvedRemovalTarget,
  buildRemovalStrips,
  resolveBrowserReviewItemContext,
} from '@synergy/review-core/browser';
import { useEffect, useRef, useState } from 'react';
import { CopyButton } from '../CopyButton.js';
import { DiffViewer, runKey } from './DiffViewer.js';
import { FileChangeViewer } from './FileChangeViewer.js';
import { HunkTabs } from './HunkTabs.js';
import { ReviewItemPanel } from './ReviewItemPanel.js';
import { SourceViewer } from './SourceViewer.js';
import type { ReviewContextValue } from './types.js';
import { chapterOf, nextPosition } from './walkthrough.js';

interface ReviewStageProps {
  bundle: ReviewBundle;
  item: ReviewItem;
  fileItems: ReviewItem[];
  fileInsight?: ReviewFileInsight;
  selectedLineIds: string[];
  noteDraft?: string;
  saving: boolean;
  walkthrough: ReviewContextValue['walkthrough'];
  jump: ReviewContextValue['jump'];
  onToggleLine(lineId: string): void;
  onNoteChange(value: string): void;
  onSaveNote(): Promise<void>;
  onSetProgress(status: 'reviewed' | 'needs-review'): Promise<void>;
  onSelectItem(reviewItemId: string): void;
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

function removalStorageKey(revisionId: string): string {
  return `synergy.review.removals.${revisionId}`;
}

/** View-only expansion preference for removal strips; a private-mode storage failure must never break the pane. */
function readExpandedRuns(revisionId: string): string[] {
  try {
    const raw = localStorage.getItem(removalStorageKey(revisionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeExpandedRuns(revisionId: string, runs: string[]): void {
  try {
    localStorage.setItem(removalStorageKey(revisionId), JSON.stringify(runs));
  } catch {
    // Private-mode or quota failures are non-fatal - expansion state is a view preference only.
  }
}

/** Directory prefix (with trailing slash) so the file name can stay visible when the bar truncates. */
function directoryPrefix(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut + 1);
}

/** Presents the exact immutable diff hunk or scoped source section under review. */
export function ReviewStage({
  bundle,
  item,
  fileItems,
  fileInsight,
  selectedLineIds,
  noteDraft,
  saving,
  walkthrough,
  jump,
  onToggleLine,
  onNoteChange,
  onSaveNote,
  onSetProgress,
  onSelectItem,
}: ReviewStageProps) {
  const context = resolveBrowserReviewItemContext(bundle.snapshot, item.id);
  const insight = bundle.insights.items.find((candidate) => candidate.reviewItemId === item.id);
  const sourceFile =
    bundle.snapshot.kind === 'scope'
      ? bundle.snapshot.files.find((file) => file.path === item.path)
      : undefined;
  const diffFile =
    bundle.snapshot.kind === 'diff'
      ? bundle.snapshot.files.find((file) => file.path === item.path)
      : undefined;
  const stageRef = useRef<HTMLElement>(null);
  const diffRows =
    bundle.snapshot.kind === 'diff' && context.item.kind === 'hunk'
      ? context.rows.filter((row) => row.kind !== 'scope')
      : undefined;
  const strips = diffRows
    ? buildRemovalStrips(diffRows, item.id, bundle.snapshot, bundle.insights)
    : [];
  const revisionId = bundle.snapshot.revisionId;
  const [expandedRuns, setExpandedRuns] = useState<string[]>(() => readExpandedRuns(revisionId));
  useEffect(() => {
    setExpandedRuns(readExpandedRuns(revisionId));
  }, [revisionId]);
  function handleToggleRun(key: string): void {
    setExpandedRuns((current) => {
      const next = current.includes(key)
        ? current.filter((candidate) => candidate !== key)
        : [...current, key];
      writeExpandedRuns(revisionId, next);
      return next;
    });
  }
  function handleJump(target: ResolvedRemovalTarget, strip: RemovalStripModel): void {
    if (target.kind !== 'in-review') return;
    jump.jumpTo(target, {
      reviewItemId: item.id,
      label: `${item.path}:${strip.run.start}`,
    });
  }
  function handleBack(): void {
    if (!jump.origin) return;
    walkthrough.advanceTo(jump.origin.reviewItemId);
    jump.clearOrigin();
  }
  const allStripKeys = strips.map((strip) => runKey(strip));
  const allStripsExpanded =
    allStripKeys.length > 0 && allStripKeys.every((key) => expandedRuns.includes(key));
  function handleToggleAll(): void {
    setExpandedRuns((current) => {
      const next = allStripsExpanded
        ? current.filter((key) => !allStripKeys.includes(key))
        : Array.from(new Set([...current, ...allStripKeys]));
      writeExpandedRuns(revisionId, next);
      return next;
    });
  }
  const currentChapter = walkthrough.enabled ? chapterOf(walkthrough.chapters, item.id) : undefined;
  const next = walkthrough.enabled ? nextPosition(walkthrough.chapters, item.id) : undefined;
  const nextChapter = next ? chapterOf(walkthrough.chapters, next.reviewItemId) : undefined;
  const crossesChapter = Boolean(
    next && currentChapter && nextChapter && nextChapter.group.id !== currentChapter.group.id,
  );
  const nextItem = next
    ? bundle.snapshot.items.find((candidate) => candidate.id === next.reviewItemId)
    : undefined;

  function handleContinue(): void {
    if (!next) return;
    walkthrough.advanceTo(next.reviewItemId);
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof stageRef.current?.scrollIntoView === 'function') {
      stageRef.current.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    }
  }

  return (
    <main className="review-stage" ref={stageRef}>
      {walkthrough.enabled && currentChapter ? (
        <div className="review-chapter-intro">
          <span className="review-chapter-intro__chip">Ch. {currentChapter.index + 1}</span>
          <div>
            <h2>{currentChapter.group.label}</h2>
            {currentChapter.group.intro ? <p>{currentChapter.group.intro}</p> : null}
          </div>
        </div>
      ) : null}
      <section className="review-stage__filebar" aria-label={`File ${item.path}`}>
        <p className="review-stage__filepath" title={item.path}>
          <span className="review-stage__filedir">{directoryPrefix(item.path)}</span>
          <span className="review-stage__filename">{fileName(item.path)}</span>
        </p>
        {strips.length > 0 ? (
          <button
            type="button"
            className="review-removal-expand-all"
            aria-pressed={allStripsExpanded}
            onClick={handleToggleAll}
          >
            {allStripsExpanded ? 'Collapse all' : 'Expand all'}
          </button>
        ) : null}
        <CopyButton label="Copy path" value={item.path} className="review-stage__filecopy" />
      </section>
      {jump.origin ? (
        <button type="button" className="review-jump-back" onClick={handleBack}>
          {`← back to ${jump.origin.label}`}
        </button>
      ) : null}
      {fileInsight ? (
        <header className="review-stage__heading">
          <div className="review-file-summary">
            <p className="review-eyebrow">What changed in this file</p>
            <p>{fileInsight.description}</p>
          </div>
        </header>
      ) : null}
      <HunkTabs
        items={fileItems}
        activeItemId={item.id}
        progress={bundle.progress.items}
        onSelect={onSelectItem}
        storyMode={walkthrough.enabled}
      />
      <p className="review-stage__meta">
        {item.kind === 'file'
          ? 'File-level change'
          : `${item.kind === 'hunk' ? 'Diff hunk' : 'Code section'} · lines ${item.range.start}–${item.range.end}`}
      </p>
      {bundle.snapshot.kind === 'diff' && context.item.kind === 'hunk' && diffRows ? (
        <DiffViewer
          path={item.path}
          rows={diffRows}
          selectedLineIds={selectedLineIds}
          onToggleLine={onToggleLine}
          strips={strips}
          expandedRuns={expandedRuns}
          onToggleRun={handleToggleRun}
          onJump={handleJump}
          flashedRowIds={jump.flashedRowIds}
        />
      ) : bundle.snapshot.kind === 'diff' && context.item.kind === 'file' && diffFile ? (
        <FileChangeViewer file={diffFile} />
      ) : bundle.snapshot.kind === 'scope' && context.item.kind === 'code-section' && sourceFile ? (
        <SourceViewer
          file={sourceFile}
          item={item}
          rows={context.rows.filter((row) => row.kind === 'scope')}
          selectedLineIds={selectedLineIds}
          onToggleLine={onToggleLine}
        />
      ) : (
        <p role="alert">This review item does not match its captured source.</p>
      )}
      <ReviewItemPanel
        item={item}
        insight={insight}
        progress={bundle.progress.items[item.id]}
        noteDraft={noteDraft}
        saving={saving}
        onNoteChange={onNoteChange}
        onSaveNote={onSaveNote}
        onSetProgress={onSetProgress}
      />
      {walkthrough.enabled ? (
        <footer className="review-continue">
          <p>
            {!next ? (
              'This was the final chapter.'
            ) : crossesChapter && nextChapter ? (
              <>
                Next chapter: <strong>{nextChapter.group.label}</strong>
                {nextChapter.group.intro ? ` · ${nextChapter.group.intro.split('.')[0]}.` : ''}
              </>
            ) : nextItem ? (
              <>
                Next file in this chapter: <strong>{fileName(nextItem.path)}</strong>
              </>
            ) : null}
          </p>
          {next ? (
            <button
              type="button"
              className="review-button review-button--primary"
              onClick={handleContinue}
            >
              {crossesChapter && nextChapter
                ? `Continue to chapter ${nextChapter.index + 1}`
                : 'Next'}
            </button>
          ) : null}
        </footer>
      ) : null}
    </main>
  );
}
