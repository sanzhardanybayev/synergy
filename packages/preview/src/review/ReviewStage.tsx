import type { ReviewBundle, ReviewFileInsight, ReviewItem } from '@synergy/review-core';
import { resolveBrowserReviewItemContext } from '@synergy/review-core/browser';
import { useRef } from 'react';
import { DiffViewer } from './DiffViewer.js';
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
  onToggleLine(lineId: string): void;
  onNoteChange(value: string): void;
  onSaveNote(): Promise<void>;
  onSetProgress(status: 'reviewed' | 'needs-review'): Promise<void>;
  onSelectItem(reviewItemId: string): void;
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
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
      <header className="review-stage__heading">
        <p title={item.path}>File · {item.path}</p>
        {fileInsight ? (
          <div className="review-file-summary">
            <p className="review-eyebrow">What changed in this file</p>
            <p>{fileInsight.description}</p>
          </div>
        ) : null}
      </header>
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
      {bundle.snapshot.kind === 'diff' && context.item.kind === 'hunk' ? (
        <DiffViewer
          rows={context.rows.filter((row) => row.kind !== 'scope')}
          selectedLineIds={selectedLineIds}
          onToggleLine={onToggleLine}
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
