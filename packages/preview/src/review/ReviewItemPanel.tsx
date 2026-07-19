import type { ReviewItem, ReviewItemInsight, ReviewItemProgress } from '@synergy/review-core';

interface ReviewItemPanelProps {
  item: ReviewItem;
  insight?: ReviewItemInsight;
  progress?: ReviewItemProgress;
  noteDraft?: string;
  saving: boolean;
  onNoteChange(value: string): void;
  onSaveNote(): Promise<void>;
  onSetProgress(status: 'reviewed' | 'needs-review'): Promise<void>;
}

/** Keeps item explanation deliberately concise and persists private reviewer decisions. */
export function ReviewItemPanel({
  item,
  insight,
  progress,
  noteDraft,
  saving,
  onNoteChange,
  onSaveNote,
  onSetProgress,
}: ReviewItemPanelProps) {
  const complete = progress?.status === 'reviewed' || progress?.status === 'carried-forward';
  const descriptionTitle =
    item.kind === 'code-section' ? 'What this code section does' : 'What this change does';
  const noteValue = noteDraft ?? progress?.note ?? '';
  const noteChanged = noteDraft !== undefined && noteDraft !== (progress?.note ?? '');
  return (
    <section className="review-item-panel" aria-labelledby="review-description-title">
      <div className="review-item-panel__description">
        <p className="review-eyebrow" id="review-description-title">
          {descriptionTitle}
        </p>
        <p>
          {insight?.description || 'This repository-aware description is still being prepared.'}
        </p>
        {insight?.confidence === 'low' ? (
          <p className="review-confidence" role="note">
            Low confidence — verify this intent against the surrounding module.
          </p>
        ) : null}
      </div>
      <label className="review-note">
        <span>Private note</span>
        <textarea
          rows={3}
          value={noteValue}
          placeholder="Capture a concern or verification result"
          onChange={(event) => onNoteChange(event.target.value)}
        />
      </label>
      <div className="review-item-panel__actions">
        <button
          type="button"
          className="review-button review-button--secondary"
          disabled={!noteChanged || saving}
          onClick={() => void onSaveNote()}
        >
          {saving && noteChanged ? 'Saving note…' : 'Save note'}
        </button>
        <button
          type="button"
          className="review-button review-button--primary"
          disabled={saving}
          onClick={() => void onSetProgress(complete ? 'needs-review' : 'reviewed')}
        >
          {saving ? 'Saving…' : complete ? 'Reopen review' : 'Mark reviewed'}
        </button>
      </div>
    </section>
  );
}
