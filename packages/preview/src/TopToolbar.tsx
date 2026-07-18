/**
 * TopToolbar — sticky bar above the MDX body on each spec page.
 *
 * Shows:
 *   - Apply all (N) button  — disabled when N=0 or diffMode is on
 *   - Discard all           — disabled when N=0
 *   - Diff: off|on toggle   — drives diffMode in the EditBuffer
 *   - Comment count badge   — value passed in via openComments prop
 *
 * Reads the buffer via useEditBuffer() for apply/discard/count.
 */

import { useCallback } from 'react';
import { useEditBuffer } from './EditBuffer.js';
import { FileDiffIcon, MessageIcon } from './icons.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TopToolbarProps {
  /** Number of open comments to display in the badge. */
  openComments: number;
  /** Whether the diff overlay is currently on. */
  diffOn: boolean;
  /** Called when the user toggles the diff view. */
  onToggleDiff: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TopToolbar({ openComments, diffOn, onToggleDiff }: TopToolbarProps) {
  const buffer = useEditBuffer();

  const handleApplyAll = useCallback(() => {
    void buffer.applyAll();
  }, [buffer]);

  const handleDiscardAll = useCallback(() => {
    buffer.discardAll();
  }, [buffer]);

  const hasEdits = buffer.dirtyCount > 0;

  return (
    <div className="top-toolbar" role="toolbar" aria-label="Page editing tools">
      <div className="top-toolbar__edit-actions">
        <button
          type="button"
          className="top-toolbar__apply-btn"
          disabled={!hasEdits || buffer.diffMode}
          onClick={handleApplyAll}
          aria-label={`Apply all ${buffer.dirtyCount} edits`}
        >
          Apply all ({buffer.dirtyCount})
        </button>

        <button
          type="button"
          className="top-toolbar__discard-btn"
          disabled={!hasEdits}
          onClick={handleDiscardAll}
          aria-label="Discard all edits"
        >
          Discard all
        </button>
      </div>

      <div className="top-toolbar__right">
        <button
          type="button"
          className={`top-toolbar__diff-toggle${diffOn ? ' top-toolbar__diff-toggle--on' : ''}`}
          onClick={onToggleDiff}
          aria-pressed={diffOn}
          aria-label={
            diffOn ? 'Diff view: on — click to turn off' : 'Diff view: off — click to turn on'
          }
        >
          <FileDiffIcon size={14} /> Diff: {diffOn ? 'on' : 'off'}
        </button>

        {openComments > 0 && (
          <span className="top-toolbar__comment-badge" aria-label={`${openComments} open comments`}>
            <span className="top-toolbar__comment-badge-icon" aria-hidden="true">
              <MessageIcon size={13} />
            </span>
            {openComments}
          </span>
        )}
      </div>
    </div>
  );
}
