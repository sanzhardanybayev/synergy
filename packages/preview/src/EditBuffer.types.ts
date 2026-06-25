/**
 * Types for the EditBuffer context.
 *
 * Kept in a sibling file so the context module stays clean and the types
 * can be imported without importing the full context (e.g. in tests).
 */

import type { AgentTreeNode } from '@synergy/spec-kit';
import type { LineCol } from './api.js';

// ---------------------------------------------------------------------------
// Discriminated-union entry types
// ---------------------------------------------------------------------------

/** An edit to a prose block (PUT /api/edit). */
export interface ProseEditEntry {
  readonly kind: 'prose';
  /** sessionsDir-relative file path (e.g. "2026-05-25-foo/00-overview.mdx"). */
  readonly file: string;
  readonly sourceStart: LineCol;
  readonly sourceEnd: LineCol;
  /**
   * The raw source text that was at this span when the block last rendered.
   * Computed from fileSource + lineColToOffset — NOT from DOM textContent.
   */
  readonly originalText: string;
  /** Current edited text (textContent of the contentEditable element). */
  currentText: string;
}

/** A status change on a Phase component (PATCH /api/status, kind=phase-frontmatter). */
export interface StatusEditEntry {
  readonly kind: 'status';
  /** sessionsDir-relative file path. */
  readonly file: string;
  /** Phase slug used to identify the phase. */
  readonly phaseSlug: string;
  readonly originalStatus: string;
  currentStatus: string;
}

/** An agent-tree edit (PUT /api/agent-tree). */
export interface AgentTreeEditEntry {
  readonly kind: 'agent-tree';
  /** sessionsDir-relative file path. */
  readonly file: string;
  readonly originalTree: AgentTreeNode[];
  currentTree: AgentTreeNode[];
}

export type BufferEntry = ProseEditEntry | StatusEditEntry | AgentTreeEditEntry;

/**
 * Stable key for a buffer entry.
 * - Prose: `${file}:${lineStart}:${colStart}`
 * - Status: `status:${file}:${phaseSlug}`
 */
export type BufferKey = string;

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface EditBufferContextValue {
  /** All current buffer entries. */
  entries: Map<BufferKey, BufferEntry>;

  /** Mark a prose block dirty (or update its currentText). */
  setDirtyProse: (key: BufferKey, entry: ProseEditEntry) => void;

  /** Mark a status dirty (or update currentStatus). */
  setDirtyStatus: (key: BufferKey, entry: StatusEditEntry) => void;

  /** Mark an agent-tree dirty (or update currentTree). */
  setDirtyAgentTree: (key: BufferKey, entry: AgentTreeEditEntry) => void;

  /** Discard a single entry (no network call). */
  discard: (key: BufferKey) => void;

  /** Apply a single entry (network call). Returns true on success. */
  applyOne: (key: BufferKey) => Promise<boolean>;

  /** Apply all dirty entries sequentially. */
  applyAll: () => Promise<void>;

  /** Discard all dirty entries. */
  discardAll: () => void;

  /** Total number of dirty entries. */
  dirtyCount: number;

  /** Whether there is at least one dirty entry. */
  isDirty: boolean;

  /** Whether diff view is active (Apply is disabled in diff mode). */
  diffMode: boolean;
  setDiffMode: (on: boolean) => void;

  /**
   * The raw MDX source for the current page's primary file.
   * Set by SpecPage / PhasePage after fetching /api/source.
   */
  fileSource: string;
  setFileSource: (src: string) => void;

  /**
   * The sessionsDir-relative file path for the current page.
   * Set by SpecPage / PhasePage.
   */
  currentFile: string;
  setCurrentFile: (file: string) => void;

  /**
   * Open comment count for the current session, surfaced by CommentsPanel via
   * onCountChange. Used by TopToolbar to show the badge without prop drilling.
   */
  openCommentCount: number;
  setOpenCommentCount: (n: number) => void;

  /**
   * Increment to trigger CommentsPanel refresh after a comment is posted.
   * Incremented by SpecPage/PhasePage via bumpCommentRefresh().
   */
  commentRefreshKey: number;
  bumpCommentRefresh: () => void;

  /**
   * When set (e.g. from CommentsPanel click), CommentHighlights scrolls to and
   * pulses the matching inline highlight.
   */
  focusedCommentId: string | null;
  focusComment: (id: string) => void;
  clearFocusedComment: () => void;
}
