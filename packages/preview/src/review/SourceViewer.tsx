import type { ReviewItem, ReviewScopeLineRow, SourceFile } from '@synergy/review-core';
import { useMemo } from 'react';
import { CodeLine, useHighlightedFile } from './HighlightedCode.js';

interface SourceViewerProps {
  file: SourceFile;
  item: ReviewItem;
  rows: ReviewScopeLineRow[];
  selectedLineIds: string[];
  onToggleLine(lineId: string): void;
}

/** Shows the complete captured file while keeping question selection inside the active section. */
export function SourceViewer({
  file,
  item,
  rows,
  selectedLineIds,
  onToggleLine,
}: SourceViewerProps) {
  const rowByLine = new Map(rows.map((row) => [row.line, row]));
  // The captured file is immutable, so its joined text only changes when the file itself does.
  const text = useMemo(() => file.lines.map((line) => line.text).join('\n'), [file]);
  const highlighted = useHighlightedFile(file.path, text);
  return (
    <section className="review-code-scroll" aria-label="Source code">
      <div className="review-source">
        {file.lines.map((line, index) => {
          const row = rowByLine.get(line.number);
          const selected = row ? selectedLineIds.includes(row.id) : false;
          const inSection = line.number >= item.range.start && line.number <= item.range.end;
          return (
            <div
              className={`review-code-row review-code-row--source${
                inSection ? ' is-in-section' : ''
              }${selected ? ' is-selected' : ''}`}
              key={line.number}
            >
              {row ? (
                <button
                  type="button"
                  className="review-code-row__select"
                  aria-label={`${selected ? 'Deselect' : 'Select'} source line ${line.number}`}
                  aria-pressed={selected}
                  onClick={() => onToggleLine(row.id)}
                >
                  {selected ? '●' : '○'}
                </button>
              ) : (
                <span className="review-code-row__select-placeholder" aria-hidden="true" />
              )}
              <span className="review-code-row__number">{line.number}</span>
              <CodeLine text={line.text} tokens={highlighted?.[index]} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
