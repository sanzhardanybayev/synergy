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
   Record the decision (resolved or rejected) in-memory; you will flush all decisions in
   step 4 as a single batch call.

**Rejecting:**

a. Decide to reject when the request is out of scope for the current spec, contradicts a
   hard design decision, or is not actionable.
b. Record the rejection decision in-memory (reason required). It will be flushed in step 4.
   The `rejection_reason` must be explicit — never silently ignore a comment.

**4. After the loop**

After all edits are applied, flush every decision in **one** batch call (prefer the daemon;
fall back to per-comment on-disk frontmatter edits when the server is down):

First run `node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" preview status --json`. If it
reports `running: true`, assign its non-null `origin` to `PREVIEW_ORIGIN` below.

```bash
curl -sS -X POST "${PREVIEW_ORIGIN}/api/feedback/resolve-batch" \
  -H 'content-type: application/json' \
  -d '{"items":[
        {"id":"<id1>","status":"resolved","resolution":"<what changed>"},
        {"id":"<id2>","status":"rejected","rejection_reason":"<why>"}
      ]}'
```

Every comment must end as `resolved` or `rejected` — never silently skipped. Check the
returned `results` array: any item with `ok: false` must be retried or its error surfaced.

Then validate to catch any cross-ref breakage introduced by edits (prefer the daemon
endpoint; fall back to the CLI when the preview is not running):

```bash
# Fast path (daemon running):
curl -sS "${PREVIEW_ORIGIN}/api/validate?session=<session>"

# Fallback (preview not running):
node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" validate <session>
```

Parse the JSON `issues` array from the daemon response: any item with `severity: "error"`
must be fixed before declaring done.

Print a concise summary:
> Addressed N, rejected M, skipped K (stale anchor). Validate: clean / failing.
If validate is failing, list the errors and fix them before declaring done.

---

## Live wait mode

When the user says they are about to review (e.g. `/synergy-feedback --wait`, "wait for my
feedback", "I'll review the spec now"), don't exit on an empty queue — block on the wait
command and let the browser wake you:

```bash
# Bounded wait (recommended default; keeps a forgotten wait from blocking forever):
node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" feedback wait <session> --for 15m
```

Execution rules (the wake path is the completion of this command — protect it):

- Run it **in the foreground** and leave it running. It streams a heartbeat to stderr and
  stays silent on stdout until the final JSON; that silence is normal — never kill it.
- Never wrap it in `nohup`, shell `&`, or a detached process just to keep it alive: if the
  process's completion cannot resume you, nobody reads the feedback.
- If it gets killed or times out anyway, re-running it is always safe — comments persist
  on disk and queued ones return immediately.

The final JSON has `status`, `comments`, and `next_step`. Follow `next_step`:

- `status: "feedback"` — process `comments` through steps 3–4 above (edit specs, flush one
  resolve-batch, validate), then **re-run the wait command** to keep listening. The user
  sees your resolutions live in the preview.
- `status: "ended"` — the user clicked **Done reviewing**. Process any `comments` in this
  final batch the same way, print the summary, and do **not** re-run the wait — the review
  round is over.
- `status: "timeout"` — return to the conversation and say no feedback arrived; re-enter
  the wait only when the user says they are reviewing again.

## Special cases

**Empty queue.** If step 2 finds zero open comments, print "No open feedback. Exiting." and stop.

**Preview server not running.** The `POST /api/feedback/resolve-batch` call will fail with
`ECONNREFUSED`. When this happens, update each comment file's frontmatter directly on disk
(they are plain markdown files). Set `status: resolved` (or `rejected`), add `resolved_at` /
`rejected_at` (ISO 8601), and `resolution` / `rejection_reason`. This is equivalent to the
batch call but bypasses the live server. Note in the summary which method was used. Also use
`node "$CLAUDE_PLUGIN_ROOT/packages/cli/dist/cli.js" validate <session>` instead of the
daemon endpoint for the final validation step.

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
