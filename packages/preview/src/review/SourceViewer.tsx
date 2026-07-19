import type { ReviewItem, ReviewScopeLineRow, SourceFile } from '@synergy/review-core';

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
  return (
    <section className="review-code-scroll" aria-label="Source code">
      <div className="review-source">
        {file.lines.map((line) => {
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
              <code>{line.text || ' '}</code>
            </div>
          );
        })}
      </div>
    </section>
  );
}
