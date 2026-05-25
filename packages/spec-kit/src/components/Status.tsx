import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StatusValue } from '../types.js';

export interface StatusProps {
  value: StatusValue;
  note?: string;
  editable?: boolean;
  dirty?: boolean;
  onChange?: (next: StatusValue) => void;
}

const ALL_STATUSES: StatusValue[] = [
  'draft',
  'proposed',
  'in-progress',
  'blocked',
  'done',
  'shipped',
];

const labelFor: Record<StatusValue, string> = {
  draft: 'Draft',
  proposed: 'Proposed',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  shipped: 'Shipped',
};

export function Status({ value, note, editable = false, dirty = false, onChange }: StatusProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  const closePopover = useCallback(() => {
    setOpen(false);
  }, []);

  const handleSelect = useCallback(
    (next: StatusValue) => {
      closePopover();
      onChange?.(next);
    },
    [closePopover, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        closePopover();
      }
    },
    [closePopover],
  );

  // Close popover on click outside the container
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closePopover();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open, closePopover]);

  const dot = <span className="sk-status__dot" aria-hidden />;
  const label = <span className="sk-status__label">{labelFor[value]}</span>;
  const pendingIndicator = dirty ? (
    <span className="sk-status__pending" aria-label="pending change" />
  ) : null;
  const noteEl = note ? <span className="sk-status__note">— {note}</span> : null;

  if (!editable) {
    return (
      <span className={clsx('sk-status', `sk-status--${value}`)} data-status={value}>
        {dot}
        {label}
        {pendingIndicator}
        {noteEl}
      </span>
    );
  }

  return (
    <span ref={containerRef} className="sk-status-container" onKeyDown={handleKeyDown}>
      <button
        type="button"
        className={clsx('sk-status', `sk-status--${value}`, 'sk-status--editable')}
        data-status={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        {dot}
        {label}
        {pendingIndicator}
        {noteEl}
      </button>

      {open ? (
        // biome-ignore lint/a11y/useSemanticElements: styled popover requires role="listbox" on a div; native <select> cannot be used here
        // biome-ignore lint/a11y/useFocusableInteractive: focus is managed by the trigger button; options are individually focusable
        <div className="sk-status-popover" role="listbox" aria-label="Select status" tabIndex={-1}>
          {ALL_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: styled option requires role="option" on a button to be keyboard-accessible
              role="option"
              aria-selected={s === value}
              className={clsx(
                'sk-status-popover__option',
                s === value && 'sk-status-popover__option--selected',
              )}
              onClick={() => handleSelect(s)}
            >
              <span
                className={clsx('sk-status__dot', `sk-status-popover__dot--${s}`)}
                aria-hidden
              />
              <span>{labelFor[s]}</span>
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
