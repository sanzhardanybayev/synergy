---
description: Address open feedback comments from the Synergy preview for the active session
argument-hint: [session-slug] [--wait]
---

Invoke the `synergy:address-feedback` skill to process the open-comment queue for the
browser-active session (or a named session if supplied).

The user's request: `$ARGUMENTS`

The skill will:

1. Resolve the target session — from `$ARGUMENTS`, from `.synergy/active-session`
   (within the 10-minute staleness window), or by prompting the user to pick from
   sessions that have open feedback.
2. List every `.synergy/feedback/<session>/*.md` file whose frontmatter `status: open`.
3. Address or reject each comment by editing the spec at the given line/col anchor,
   then PATCH the comment file via `PATCH /api/feedback/:id`.
4. Run `synergy validate <session>` and print a final summary.

Follow the skill's procedure exactly — do not skip the validate step.

With `--wait` (or when the user says they are about to review), follow the skill's
**Live wait mode**: block on `synergy feedback wait <session>` in the foreground and loop
until the user clicks **Done reviewing** or the wait times out.
