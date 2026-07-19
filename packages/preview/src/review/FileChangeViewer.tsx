import type { FileChangeViewerProps } from './types.js';

function statusLabel(status: FileChangeViewerProps['file']['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Summarizes an immutable file-level change without inventing selectable code rows. */
export function FileChangeViewer({ file }: FileChangeViewerProps) {
  return (
    <section className="review-file-change" aria-label="File-level change details">
      <p>This change contains no textual diff rows.</p>
      <dl>
        <div>
          <dt>Change</dt>
          <dd>{statusLabel(file.status)}</dd>
        </div>
        {file.previousPath ? (
          <div>
            <dt>Previous path</dt>
            <dd>{file.previousPath}</dd>
          </div>
        ) : null}
        {file.oldMode || file.newMode ? (
          <div>
            <dt>Mode</dt>
            <dd>
              {file.oldMode ?? 'none'} → {file.newMode ?? 'none'}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
