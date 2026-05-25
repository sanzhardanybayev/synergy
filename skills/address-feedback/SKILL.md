---
name: address-feedback
description: Use when the user runs /synergy-feedback or asks Claude to address browser-collected feedback comments from a Synergy preview session. Resolves the active session (via .synergy/active-session, ≤10-min staleness window), processes each open comment, edits the spec via line/col anchors, and PATCHes each comment to resolved or rejected.
---

# address-feedback

Processes the open-comment queue for a Synergy session. For the rules of editing existing
specs (component usage, CrossRef discipline, phase folder layout), see `synergy:spec-authoring`.

Resolved and rejected comments remain on disk as an audit trail — never delete them.

---

## Steps

**1. Resolve the session**

- If the user passed an argument (e.g. `/synergy-feedback 2026-05-25-foo`), use it as the
  session slug. Skip the remaining sub-steps.
- Otherwise, read `.synergy/active-session`. The file is JSON: `{ "session": "...", "lastSeen": "..." }`.
  - If `lastSeen` is within the last **10 minutes** (compare to `Date.now()`), use that session.
  - If `lastSeen` is older than 10 minutes, confirm with the user before continuing:
    > "The preview was last active N min ago — use `<session>` or pick another?"
    Wait for a response before proceeding.
- If `.synergy/active-session` does not exist, scan `.synergy/feedback/` for session directories
  that contain at least one `.md` file with frontmatter `status: open`. Present the list:
  > "Which session has the feedback you want to address? 1) … 2) …"
  Wait for a selection.

**2. List open comments**

- Read every file matching `.synergy/feedback/<session>/*.md`.
- Parse each file's YAML frontmatter. Keep only files where `status: open`.
- For each open comment, display:
  - The comment file path (e.g. `.synergy/feedback/<session>/2026-05-25T093045-abc123.md`).
  - The source anchor: `(lineStart:colStart .. lineEnd:colEnd)` — coordinates inside
    `.synergy/sessions/<session>/<file>`.
  - The context snippet: `"<before>**<selected>**<after>"` (use bold in Markdown output).
  - The comment body.
- If the queue is empty, print "No open feedback. Exiting." and stop.

**3. Address or reject each comment**

For each open comment in order:

**Addressing (editing the spec):**

a. Determine the target file: `.synergy/sessions/<session>/<comment.file>`.
b. Try line/col first — open the file, navigate to `(lineStart:colStart)`, confirm the
   text at that span equals `anchor.selected`. If it matches, apply the edit there.
c. If the span text does not match (line/col drift), search the file for the string
   `anchor.before + anchor.selected + anchor.after`. If it resolves to a **unique** match,
   apply the edit at the matched position.
d. If both checks fail, mark the comment as **STALE** in the final summary and skip it —
   do not guess.
e. Apply the edit using the **Edit tool** (never write the full file). Follow the
   `synergy:spec-authoring` rules for the specific change (prose edit, status flip, etc.).
f. PATCH the comment to resolved:
   ```bash
   curl -sS -X PATCH http://localhost:4321/api/feedback/<id> \
     -H 'content-type: application/json' \
     -d '{"status":"resolved","resolution":"<one-line description of change>"}'
   ```
   The `resolution` must describe what was actually changed (not just "done").

**Rejecting:**

a. Decide to reject when the request is out of scope for the current spec, contradicts a
   hard design decision, or is not actionable.
b. PATCH the comment to rejected:
   ```bash
   curl -sS -X PATCH http://localhost:4321/api/feedback/<id> \
     -H 'content-type: application/json' \
     -d '{"status":"rejected","rejection_reason":"<reason>"}'
   ```
   The `rejection_reason` must be explicit — never silently ignore a comment.

**4. After the loop**

- Run `synergy validate <session>` to catch any cross-ref breakage introduced by edits:
  ```bash
  node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" validate <session>
  ```
- Print a concise summary:
  > Addressed N, rejected M, skipped K (stale anchor). Validate: clean / failing.
  If validate is failing, list the errors and fix them before declaring done.

---

## Special cases

**Empty queue.** If step 2 finds zero open comments, print "No open feedback. Exiting." and stop.

**Preview server not running.** The PATCH calls will fail with `ECONNREFUSED`. When this
happens, print:
> "Preview server is not running. Start it with `synergy preview start`, then retry `/synergy-feedback`."
As a fallback, you MAY update the comment file's frontmatter directly on disk (they are plain
markdown files) instead of calling the API. Set `status: resolved` (or `rejected`), add
`resolved_at` / `rejected_at` (ISO 8601), and `resolution` / `rejection_reason`. This is
equivalent to the PATCH but bypasses the live server. Note in the summary which method was used.

**Line/col drift.** Always try the exact span first; fall back to the `before+selected+after`
context string. If neither locates a unique, unambiguous match, mark as STALE and skip — do
not guess at the intended location.

---

## Don'ts

- Don't silently skip a comment without either resolving or rejecting it.
- Don't delete comment files — resolved and rejected ones stay as audit trail.
- Don't use raw markdown links when editing a spec. Follow `synergy:spec-authoring` component rules.
- Don't run `synergy validate` before finishing all edits — one pass at the end is enough.
- Don't mark a comment resolved if the edit could not be applied (stale anchor). Mark it STALE.
