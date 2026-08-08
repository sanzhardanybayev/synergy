import type { ReviewBundle, ReviewFileInsight, ReviewItem } from '@synergy/review-core';
import { resolveBrowserReviewItemContext } from '@synergy/review-core/browser';
import { DiffViewer } from './DiffViewer.js';
import { FileChangeViewer } from './FileChangeViewer.js';
import { HunkTabs } from './HunkTabs.js';
import { ReviewItemPanel } from './ReviewItemPanel.js';
import { SourceViewer } from './SourceViewer.js';

interface ReviewStageProps {
  bundle: ReviewBundle;
  item: ReviewItem;
  fileItems: ReviewItem[];
  fileInsight?: ReviewFileInsight;
  selectedLineIds: string[];
  noteDraft?: string;
  saving: boolean;
  onToggleLine(lineId: string): void;
  onNoteChange(value: string): void;
  onSaveNote(): Promise<void>;
  onSetProgress(status: 'reviewed' | 'needs-review'): Promise<void>;
  onSelectItem(reviewItemId: string): void;
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
  return (
    <main className="review-stage">
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
      />
      <div className="review-stage__item">
        <h2>{item.label}</h2>
        <span>
          {item.kind === 'file'
            ? 'File-level change'
            : `${item.kind === 'hunk' ? 'Diff hunk' : 'Code section'} · lines ${item.range.start}–${item.range.end}`}
        </span>
      </div>
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
    </main>
  );
}
