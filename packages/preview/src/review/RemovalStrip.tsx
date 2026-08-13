import type {
  RemovalStrip as RemovalStripModel,
  ResolvedRemovalTarget,
} from '@synergy/review-core/browser';
import { CodeLine, useHighlightedFile } from './HighlightedCode.js';

interface RemovalStripProps {
  strip: RemovalStripModel;
  expanded: boolean;
  onToggle(): void;
  onJump(target: ResolvedRemovalTarget): void;
}

const REASON_LABEL: Record<string, string> = {
  moved: 'moved',
  merged: 'merged',
  replaced: 'replaced',
  'dead-code': 'dead-code',
  obsolete: 'obsolete',
  'extracted-to-dep': 'extracted to dep',
  unclear: 'unclear',
};

interface ExcerptPeekProps {
  path: string;
  start: number;
  lines: string[];
}

/** Read-only peek at the destination text for a target outside the captured review. */
function ExcerptPeek({ path, start, lines }: ExcerptPeekProps) {
  const highlighted = useHighlightedFile(path, lines.join('\n'));
  return (
    <div className="review-removal__peek">
      <div className="review-removal__peek-head">{`${path} · lines ${start}-${start + lines.length - 1}`}</div>
      <pre>
        {lines.map((line, index) => (
          // Excerpt lines are an immutable, position-ordered snapshot with no other identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here.
          <div key={index}>
            <CodeLine text={line} tokens={highlighted?.[index]} />
          </div>
        ))}
      </pre>
    </div>
  );
}

/** One collapsed row per removal run: category, size, and destination stay visible while scanning. */
export function RemovalStrip({ strip, expanded, onToggle, onJump }: RemovalStripProps) {
  const { rationale, run, target } = strip;
  if (!rationale) return null;
  const count = run.end - run.start + 1;
  return (
    <div className="review-removal">
      <div className="review-removal__row">
        <button
          type="button"
          className="review-removal__strip"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className="review-removal__caret" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span className={`review-removal__cat review-removal__cat--${rationale.reason}`}>
            {REASON_LABEL[rationale.reason] ?? rationale.reason}
          </span>
          <span className="review-removal__count">
            {count} {count === 1 ? 'line' : 'lines'} removed
          </span>
        </button>
        {target.kind === 'in-review' ? (
          <button type="button" className="review-removal__jump" onClick={() => onJump(target)}>
            {`→ ${target.path}:${target.start}`}
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div className="review-removal__detail">
          <p>{rationale.description}</p>
          {target.kind === 'excerpt' ? (
            <ExcerptPeek path={target.path} start={target.start} lines={target.lines} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
