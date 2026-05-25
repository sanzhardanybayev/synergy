/**
 * Typed fetch client for all /api/* endpoints exposed by vite-plugin-edit.
 *
 * All endpoints are same-origin (port 4321). "file" paths are relative to
 * sessionsDir (e.g. "2026-05-25-foo/00-overview.mdx").
 *
 * Error modelling:
 *  - PUT /api/edit + PATCH /api/status: 409 → discriminated result with
 *    ok:false + reason. 404/400 also modelled as ok:false.
 *  - GET /api/diff + POST /api/review: not-a-git-repo modelled as
 *    { available: false }.
 *  - All other failures throw an Error with a descriptive message.
 */

// ---------------------------------------------------------------------------
// Shared coordinate types
// ---------------------------------------------------------------------------

export interface LineCol {
  line: number; // 1-indexed
  col: number; // 0-indexed
}

// ---------------------------------------------------------------------------
// PUT /api/edit
// ---------------------------------------------------------------------------

export interface EditRequest {
  file: string;
  sourceStart: LineCol;
  sourceEnd: LineCol;
  expectedText: string;
  newText: string;
}

export type EditResult =
  | { ok: true; newSize: number }
  | { ok: false; reason: 'stale_range'; currentText: string }
  | { ok: false; reason: 'not_found' | 'bad_request' | 'error'; detail?: string };

export async function putEdit(req: EditRequest): Promise<EditResult> {
  const res = await fetch('/api/edit', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (res.status === 200) {
    const data = (await res.json()) as { ok: boolean; newSize: number };
    return { ok: true, newSize: data.newSize };
  }

  if (res.status === 409) {
    const data = (await res.json()) as { error: string; currentText?: string };
    return { ok: false, reason: 'stale_range', currentText: data.currentText ?? '' };
  }

  if (res.status === 404) {
    return { ok: false, reason: 'not_found' };
  }

  if (res.status === 400) {
    const data = (await res.json()) as { error?: string };
    return { ok: false, reason: 'bad_request', detail: data.error };
  }

  const text = await res.text();
  return { ok: false, reason: 'error', detail: text };
}

// ---------------------------------------------------------------------------
// PATCH /api/status
// ---------------------------------------------------------------------------

export type StatusRequest =
  | { kind: 'phase-frontmatter'; file: string; newStatus: string }
  | {
      kind: 'inline-status';
      file: string;
      sourceStart: LineCol;
      sourceEnd: LineCol;
      expectedText: string;
      newStatus: string;
    };

export type StatusResult =
  | { ok: true }
  | { ok: false; reason: 'stale_range'; currentText: string }
  | { ok: false; reason: 'not_found' | 'bad_request' | 'error'; detail?: string };

export async function patchStatus(req: StatusRequest): Promise<StatusResult> {
  const res = await fetch('/api/status', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (res.status === 200) {
    return { ok: true };
  }

  if (res.status === 409) {
    const data = (await res.json()) as { error: string; currentText?: string };
    return { ok: false, reason: 'stale_range', currentText: data.currentText ?? '' };
  }

  if (res.status === 404) {
    return { ok: false, reason: 'not_found' };
  }

  if (res.status === 400) {
    const data = (await res.json()) as { error?: string };
    return { ok: false, reason: 'bad_request', detail: data.error };
  }

  const text = await res.text();
  return { ok: false, reason: 'error', detail: text };
}

// ---------------------------------------------------------------------------
// POST /api/feedback
// ---------------------------------------------------------------------------

export interface CommentAnchor {
  lineStart: number;
  colStart: number;
  lineEnd: number;
  colEnd: number;
  before: string;
  selected: string;
  after: string;
}

export interface FeedbackPostRequest {
  session: string;
  file: string;
  anchor: CommentAnchor;
  body: string;
}

export interface FeedbackPostResponse {
  id: string;
  path: string;
}

export async function postFeedback(req: FeedbackPostRequest): Promise<FeedbackPostResponse> {
  const res = await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/feedback failed (${res.status}): ${text}`);
  }

  return (await res.json()) as FeedbackPostResponse;
}

// ---------------------------------------------------------------------------
// GET /api/feedback
// ---------------------------------------------------------------------------

export type CommentStatus = 'open' | 'resolved' | 'rejected';

export interface Comment {
  id: string;
  session: string;
  file: string;
  status: CommentStatus;
  created: string;
  anchor: CommentAnchor;
  body: string;
  resolution?: string;
  rejection_reason?: string;
  resolved_at?: string;
  rejected_at?: string;
}

export interface FeedbackListResponse {
  comments: Comment[];
}

export async function listFeedback(session: string): Promise<FeedbackListResponse> {
  const res = await fetch(`/api/feedback?session=${encodeURIComponent(session)}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /api/feedback failed (${res.status}): ${text}`);
  }

  return (await res.json()) as FeedbackListResponse;
}

// ---------------------------------------------------------------------------
// PATCH /api/feedback/:id
// ---------------------------------------------------------------------------

export type FeedbackPatchRequest =
  | { status: 'resolved'; resolution: string }
  | { status: 'rejected'; rejection_reason: string };

export async function patchFeedback(id: string, req: FeedbackPatchRequest): Promise<void> {
  const res = await fetch(`/api/feedback/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH /api/feedback/${id} failed (${res.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// GET /api/diff
// ---------------------------------------------------------------------------

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffData {
  available: true;
  file: string;
  head: string;
  reviewedAt: string | null;
  hunks: Hunk[];
  uncommittedHunks: Hunk[];
}

export type DiffResult = DiffData | { available: false };

export async function getDiff(file: string): Promise<DiffResult> {
  const res = await fetch(`/api/diff?file=${encodeURIComponent(file)}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /api/diff failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { error?: string } & Partial<DiffData>;

  if (data.error === 'not_a_git_repo') {
    return { available: false };
  }

  return {
    available: true,
    file: data.file ?? file,
    head: data.head ?? '',
    reviewedAt: data.reviewedAt ?? null,
    hunks: data.hunks ?? [],
    uncommittedHunks: data.uncommittedHunks ?? [],
  };
}

// ---------------------------------------------------------------------------
// POST /api/review
// ---------------------------------------------------------------------------

export interface ReviewData {
  available: true;
  ok: true;
  reviewedAt: string;
  warn?: 'uncommitted_changes_present';
}

export type ReviewResult = ReviewData | { available: false };

export async function postReview(file: string): Promise<ReviewResult> {
  const res = await fetch('/api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/review failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    error?: string;
    ok?: boolean;
    reviewedAt?: string;
    warn?: string;
  };

  if (data.error === 'not_a_git_repo') {
    return { available: false };
  }

  return {
    available: true,
    ok: true,
    reviewedAt: data.reviewedAt ?? '',
    ...(data.warn === 'uncommitted_changes_present'
      ? { warn: 'uncommitted_changes_present' as const }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// GET /api/source
// ---------------------------------------------------------------------------

export interface SourceResponse {
  file: string;
  source: string;
}

/** Fetch the raw MDX source text for a sessionsDir-relative file path. */
export async function getSource(file: string): Promise<string> {
  const res = await fetch(`/api/source?file=${encodeURIComponent(file)}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /api/source failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as SourceResponse;
  return data.source;
}

// ---------------------------------------------------------------------------
// POST /api/active-session
// ---------------------------------------------------------------------------

export async function postActiveSession(session: string): Promise<void> {
  const res = await fetch('/api/active-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/active-session failed (${res.status}): ${text}`);
  }
}
