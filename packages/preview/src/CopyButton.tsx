import { useCallback } from 'react';
import { copyToClipboard } from './clipboard.js';
import { useToast } from './ToastProvider.js';

interface Props {
  /** Human-readable label shown on the button. */
  label: string;
  /** The string written to the clipboard on click. */
  value: string;
  /** Optional extra class names. */
  className?: string;
  /** Optional override for the icon. Defaults to a clipboard glyph. */
  icon?: string;
}

export function CopyButton({ label, value, className, icon = '📋' }: Props) {
  const { show } = useToast();

  const onClick = useCallback(async () => {
    const ok = await copyToClipboard(value);
    show(ok ? 'Copied!' : 'Copy failed');
  }, [value, show]);

  return (
    <button
      type="button"
      className={['copy-btn', className].filter(Boolean).join(' ')}
      title={value}
      onClick={onClick}
    >
      <span aria-hidden="true" className="copy-btn__icon">
        {icon}
      </span>
      <span className="copy-btn__label">{label}</span>
    </button>
  );
}
