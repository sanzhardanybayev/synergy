/**
 * EditBuffer — React context holding the in-memory dirty-edit buffer.
 *
 * Design:
 *  - Keyed by a stable BufferKey derived from file + source coordinates.
 *  - applyOne calls putEdit (prose) or patchStatus (status) and handles 409
 *    by toasting + PRESERVING the entry (never discard on conflict).
 *  - diffMode disables Apply from the toolbar (Discard still works).
 *  - fileSource / currentFile are set by each spec page after fetching
 *    /api/source so EditableBlock can compute expectedText accurately.
 */

import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';
import type {
  BufferEntry,
  BufferKey,
  EditBufferContextValue,
  ProseEditEntry,
  StatusEditEntry,
} from './EditBuffer.types.js';
import { useToast } from './ToastProvider.js';
import { patchStatus, putEdit } from './api.js';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const EditBufferContext = createContext<EditBufferContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function EditBufferProvider({ children }: { children: ReactNode }) {
  const { show: showToast } = useToast();

  const [entries, setEntries] = useState<Map<BufferKey, BufferEntry>>(new Map());
  const [diffMode, setDiffMode] = useState(false);
  const [fileSource, setFileSource] = useState('');
  const [currentFile, setCurrentFile] = useState('');
  const [openCommentCount, setOpenCommentCount] = useState(0);
  const [commentRefreshKey, setCommentRefreshKey] = useState(0);
  const bumpCommentRefresh = useCallback(() => setCommentRefreshKey((k) => k + 1), []);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);
  const focusComment = useCallback((id: string) => setFocusedCommentId(id), []);
  const clearFocusedComment = useCallback(() => setFocusedCommentId(null), []);

  // -------------------------------------------------------------------------
  // Mutators
  // -------------------------------------------------------------------------

  const setDirtyProse = useCallback((key: BufferKey, entry: ProseEditEntry) => {
    setEntries((prev) => {
      const next = new Map(prev);
      const existing = next.get(key);
      if (existing && existing.kind === 'prose') {
        // Update only currentText to avoid clobbering originalText.
        next.set(key, { ...existing, currentText: entry.currentText });
      } else {
        next.set(key, entry);
      }
      return next;
    });
  }, []);

  const setDirtyStatus = useCallback((key: BufferKey, entry: StatusEditEntry) => {
    setEntries((prev) => {
      const next = new Map(prev);
      const existing = next.get(key);
      if (existing && existing.kind === 'status') {
        next.set(key, { ...existing, currentStatus: entry.currentStatus });
      } else {
        next.set(key, entry);
      }
      return next;
    });
  }, []);

  const discard = useCallback((key: BufferKey) => {
    setEntries((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // -------------------------------------------------------------------------
  // applyOne — returns true on success, false on failure (keeps entry).
  // -------------------------------------------------------------------------

  const applyOne = useCallback(
    async (key: BufferKey): Promise<boolean> => {
      const entry = entries.get(key);
      if (!entry) return true; // already gone

      try {
        if (entry.kind === 'prose') {
          const result = await putEdit({
            file: entry.file,
            sourceStart: entry.sourceStart,
            sourceEnd: entry.sourceEnd,
            expectedText: entry.originalText,
            newText: entry.currentText,
          });

          if (result.ok) {
            discard(key);
            return true;
          }

          if (result.reason === 'stale_range') {
            showToast(
              'Edit conflict: the file changed since you started editing. HMR will refresh — re-apply if still relevant.',
            );
            // Do NOT discard — preserve the user's typed text.
            return false;
          }

          if (result.reason === 'not_found') {
            showToast('File not found — it may have been deleted. Edit discarded.');
            discard(key);
            return false;
          }

          showToast(`Write failed: ${result.detail ?? 'unknown error'}`);
          return false;
        }

        if (entry.kind === 'status') {
          const result = await patchStatus({
            kind: 'phase-frontmatter',
            file: entry.file,
            newStatus: entry.currentStatus,
          });

          if (result.ok) {
            discard(key);
            return true;
          }

          if (result.reason === 'stale_range') {
            showToast('Status conflict: file changed. Re-apply after HMR refresh.');
            return false;
          }

          showToast(`Status write failed: ${result.detail ?? 'unknown error'}`);
          return false;
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Unknown write error');
        return false;
      }

      return true;
    },
    [entries, discard, showToast],
  );

  // -------------------------------------------------------------------------
  // applyAll — sequential to avoid write-write races on the same file.
  // -------------------------------------------------------------------------

  const applyAll = useCallback(async () => {
    const keys = [...entries.keys()];
    for (const key of keys) {
      await applyOne(key);
    }
  }, [entries, applyOne]);

  // -------------------------------------------------------------------------
  // discardAll
  // -------------------------------------------------------------------------

  const discardAll = useCallback(() => {
    setEntries(new Map());
  }, []);

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const dirtyCount = entries.size;
  const isDirty = dirtyCount > 0;

  // -------------------------------------------------------------------------
  // Context value (stable reference when nothing changes)
  // -------------------------------------------------------------------------

  const value = useMemo<EditBufferContextValue>(
    () => ({
      entries,
      setDirtyProse,
      setDirtyStatus,
      discard,
      applyOne,
      applyAll,
      discardAll,
      dirtyCount,
      isDirty,
      diffMode,
      setDiffMode,
      fileSource,
      setFileSource,
      currentFile,
      setCurrentFile,
      openCommentCount,
      setOpenCommentCount,
      commentRefreshKey,
      bumpCommentRefresh,
      focusedCommentId,
      focusComment,
      clearFocusedComment,
    }),
    // NOTE: useState setters (setDiffMode/setFileSource/setCurrentFile/
    // setOpenCommentCount) are intentionally omitted — they are stable, and
    // biome's useExhaustiveDependencies flags them as unnecessary if listed.
    [
      entries,
      setDirtyProse,
      setDirtyStatus,
      discard,
      applyOne,
      applyAll,
      discardAll,
      dirtyCount,
      isDirty,
      diffMode,
      fileSource,
      currentFile,
      openCommentCount,
      commentRefreshKey,
      bumpCommentRefresh,
      focusedCommentId,
      focusComment,
      clearFocusedComment,
    ],
  );

  return <EditBufferContext.Provider value={value}>{children}</EditBufferContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useEditBuffer(): EditBufferContextValue {
  const ctx = useContext(EditBufferContext);
  if (!ctx) {
    throw new Error('useEditBuffer must be used inside <EditBufferProvider>');
  }
  return ctx;
}

// Re-export types for convenience.
export type {
  BufferEntry,
  BufferKey,
  ProseEditEntry,
  StatusEditEntry,
} from './EditBuffer.types.js';
