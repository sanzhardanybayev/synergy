---
name: review
description: Use when the user wants a guided human review of a GitHub PR, staged changes, unstaged changes, or a bounded current-code scope, or wants to resume an exact Synergy review and answer browser questions. Captures immutable revisions, creates repository-aware review groups and concise item descriptions, opens the local portal, and runs the durable question loop.
---

<!-- synergy-version: 0.12.0 -->

## Step 0 — Freshness check

This skill may remain loaded after Synergy is updated. Set `MINE` from the marker above and
run the installed-version check used by the other Synergy skills:

```bash
MINE="0.12.0"
CACHE="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}/cache/synergy/synergy"
NEWEST="$(ls "$CACHE" 2>/dev/null | sort -V | tail -1)"
if [ -n "$NEWEST" ] && [ "$NEWEST" != "$MINE" ] && \
   [ "$(printf '%s\n%s\n' "$MINE" "$NEWEST" | sort -V | tail -1)" = "$NEWEST" ]; then
  printf '⚠ synergy: this session loaded v%s, but v%s is installed. Restart Claude Code to load the latest skills/templates.\n' "$MINE" "$NEWEST"
fi
```

Surface any warning verbatim, then continue. Freshness is a warning, not a block.

# Guided code review

Use Synergy to split one exact Git-backed source into manageable items for a human. Keep
capture, fingerprints, persistence, reconciliation, and validation inside the CLI. Use
agent judgment only for grouping, scoped section boundaries, concise explanations, and
answers.

Resolve `<synergy-root>` from this skill's installed location (`skills/review/SKILL.md` is
two directories below it). Claude Code may expose the same root as `$CLAUDE_PLUGIN_ROOT`;
do not require that variable so the workflow also works in Codex. Use this CLI base below:

```text
node "<synergy-root>/packages/cli/dist/cli.js"
```

If the built CLI is absent, tell the user to run the Synergy setup command. Do not invent a
different command surface.

Resolve `<project-root>` once from the consumer's current directory by running
`git rev-parse --show-toplevel`. Require successful output that is an absolute path, then
reuse that exact value for the entire workflow even when the skill was invoked from a nested
package or feature directory. Do not confuse `<project-root>` with `<synergy-root>`: the first
contains the reviewed repository and its `.synergy/` data; the second contains the installed
CLI and skill templates.

## 1. Resolve intent

Accept one of these mutually exclusive intents:

- PR: a number or GitHub pull-request URL.
- Staged: the current Git index.
- Unstaged: tracked worktree changes plus non-ignored untracked files.
- Scope: explicit repository-relative paths or a natural-language module that you first
  resolve to bounded repository-relative paths.
- Resume: an exact `<workspace@revision>` or a workspace ID.

Require a Git repository. If intent is ambiguous, ask one focused question. An exact
`<workspace@revision>` always means the exact immutable revision: never refresh or advance
it implicitly. A workspace-only resume means refresh/reconcile its current source.

## 2. Capture or resume through the CLI

Run the matching command and consume its output; use `--json` for create/status/list data:

```text
node "<synergy-root>/packages/cli/dist/cli.js" review create --pr <number-or-url> --json --root "<project-root>"
node "<synergy-root>/packages/cli/dist/cli.js" review create --staged --json --root "<project-root>"
node "<synergy-root>/packages/cli/dist/cli.js" review create --unstaged --json --root "<project-root>"
node "<synergy-root>/packages/cli/dist/cli.js" review create --scope <repository-relative-path> --json --root "<project-root>"
node "<synergy-root>/packages/cli/dist/cli.js" review refresh <workspace-id> --root "<project-root>"
node "<synergy-root>/packages/cli/dist/cli.js" review status <workspace@revision> --json --root "<project-root>"
node "<synergy-root>/packages/cli/dist/cli.js" review open <workspace@revision> --root "<project-root>"
```

CAC accepts the documented `--root` option after the action's positional arguments; keep it
on every invocation. Parse the returned `reference`; do not infer IDs from branch names or
paths. For exact resume, run status directly. For workspace-only resume, run refresh, parse the
resulting reference, then status. Read `analysisRequired` from create/status output. When it is
false, preserve the finalized analysis and skip step 3; never resubmit analysis to an immutable
revision.

Stop without creating an empty review when Git, GitHub authentication, a PR, or the selected
changes are unavailable. Report the CLI's corrective action. For scope, show the resolved
eligible file and line counts. If the scope is unexpectedly broad, obtain explicit user
confirmation before analysis. Git decides eligibility; never add ignored untracked files
or invent a parallel ignore mechanism.

Read the immutable snapshot only after capture succeeds:
`<project-root>/.synergy/reviews/<workspace-id>/revisions/<revision-id>/snapshot.json`. Treat
it as read-only. Never hand-write, repair, or directly mutate any file under
`<project-root>/.synergy/reviews/`.

## 3. Analyze the exact revision

Use the snapshot as the source of item IDs, captured rows, paths, source metadata, and exact
revision identity. Before reading live repository context, run the rooted status invocation
from step 2. If it reports changed source or capture failure, preserve the snapshot, surface
the condition, and offer the rooted refresh invocation; never silently mix a newer source
into the analysis.

Inspect context according to source kind:

- PR: inspect the captured `headSha` and `baseSha` with Git object commands such as
  `git -C "<project-root>" show <sha>:<path>`, not the checked-out worktree. Verify each
  object first; when it is absent, fetch that exact object without checking it out. If exact
  retrieval fails, use only captured rows and mark the affected insight low confidence.
- Staged: inspect index blobs with `git -C "<project-root>" show :<path>` after freshness
  succeeds.
- Unstaged: inspect eligible worktree files only after freshness succeeds.
- Scope: inspect the captured source rows and eligible worktree files only after freshness
  succeeds.

Batch related files and items. For every batch, search the repository's eligible context for
the containing module, imports, exports, callers, types, tests, configuration, related
hooks/stores/providers, and nearby implementation patterns. Use only relevant evidence.

Create readable groups and one insight per item:

- Diff: explain **what this change does** in its application role.
- Scope: explain **what this code section does** in its application role.
- Use one or two sentences. Do not paraphrase syntax or write a change-story essay.
- Record only captured eligible paths as evidence.
- Mark `low confidence` when evidence cannot establish purpose. Never invent behavior.

For scoped reviews, propose bounded, non-overlapping sections around meaningful functions,
hooks, components, classes, or configuration blocks. Cover every intended line with the
smallest useful sections; use a whole file only when no smaller boundary helps review. Derive
their review item IDs by applying review-core's exported `applyCodeSections` to the immutable
snapshot in memory. Do not reimplement its fingerprint algorithm and do not persist the
returned snapshot; `analysis-set` is the only publication path.

Generate a temporary payload that conforms to
`<synergy-root>/skills/review/templates/analysis-schema.json`. Do not place it in the review
artifact tree. Submit it only through:

```text
node "<synergy-root>/packages/cli/dist/cli.js" review analysis-set <workspace@revision> --body-file <temporary-analysis-json> --root "<project-root>"
```

The CLI validates IDs, ranges, coverage, evidence paths, relationships, and immutability.
Fix the temporary payload when validation fails; never bypass the command or patch the
artifacts.

## 4. Open the review

Start the preview idempotently, then ask the CLI for the immutable route:

```text
node "<synergy-root>/packages/cli/dist/cli.js" preview start --root "<project-root>"
node "<synergy-root>/packages/cli/dist/cli.js" review open <workspace@revision> --root "<project-root>"
```

Report the full `http://localhost:4321/r/<workspace>/<revision>` URL. If the preview cannot
start, preserve the review and explain that CLI/file persistence still works; do not claim
the browser is available.

## 5. Answer browser questions

When the user asks to listen, reconnects a task, or begins reviewing, run:

```text
node "<synergy-root>/packages/cli/dist/cli.js" review wait <workspace@revision> --for 15m --root "<project-root>"
```

Run the wait command in the foreground. Silence before its final JSON is normal. Never use
`nohup`, `&`, or a detached process: completion must resume this agent so queued questions
are actually processed. A timeout is not an error; tell the user no question arrived and
wait again only when requested.

For each returned question:

1. Verify its workspace and revision match the requested exact immutable revision.
2. Run the rooted status invocation again. Use the question's captured `itemContext`, selected line IDs,
   description, and immutable snapshot as primary evidence.
3. Add repository context using the source-specific rules in step 3. If live/index source is
   stale, say so and rely only on captured evidence; do not answer as though newer files
   belonged to the snapshot.
4. Answer the question directly and concisely. Separate observed code facts from inference
   when the distinction matters. Surface low confidence instead of guessing.
5. Create a temporary Markdown body using
   `<synergy-root>/skills/review/templates/question-answer.md`, then persist it through:

```text
node "<synergy-root>/packages/cli/dist/cli.js" review answer <question-id> --review <workspace@revision> --body-file <temporary-answer-md> --root "<project-root>"
```

After every successful answer batch, re-run the wait command in the foreground. Questions
and answers are durable, so retrying after interruption is safe. If answering fails, report
the failure and leave the question retryable; never mark it answered by editing files.

## Safety boundaries

- Never mutate application code merely because a review question was asked. Discuss first;
  change code only after an explicit implementation request.
- Never hand-write review JSON, question generations, answers, progress, or active pointers.
- Never analyze Gitignored untracked content. Tracked or force-added files remain eligible
  because Git says they are part of the source.
- Never carry analysis from a different revision without CLI reconciliation.
- Never replace stale or low-confidence evidence with assumptions.
- Never detach the foreground question wait.

## Completion

Use the rooted `review status <workspace@revision> --json --root "<project-root>"` invocation
as the readiness authority. A review is ready only when it reports no pending or stale items,
no unanswered questions, and unchanged source. Report concrete blockers exactly; do not
override readiness in prose.
