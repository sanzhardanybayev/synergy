# Synergy Review — Guided Human Code Review

- **Status:** Draft — conversational design approved; written review pending
- **Date:** 2026-07-19
- **Relationship to existing Synergy:** Additive. Planning/specification sessions remain unchanged. Review is a separate domain rendered by the existing Vite preview and visual system.

## Problem

Large pull requests and unfamiliar modules are difficult to review as flat lists of files. A human reviewer must repeatedly reconstruct how files relate, decide where to begin, remember which pieces were read, and move selected code into a separate agent conversation to ask questions. The current one-off PR review portal proved that a guided, chunked interface materially improves comprehension, but it is tied to one PR and only copies prompts to the clipboard.

Synergy needs a reusable review workflow that:

1. Splits PR, staged, unstaged, and scoped codebase reviews into manageable review items.
2. Explains each item concisely using context from the full repository.
3. Persists review progress and exact source snapshots.
4. Sends selected-line questions directly from the browser to Claude Code or Codex and streams durable answers back.
5. Safely reconciles prior coverage when the reviewed source changes.

## Goals

- A manually triggered `synergy:review` skill and `/synergy-review` Claude Code command.
- Four review sources: GitHub PR, staged changes, unstaged changes, and an explicit codebase scope.
- One Vite-rendered review experience using the existing Ember & Graphite `--syn-*` tokens.
- Guided grouping, file navigation, review-item checkboxes, progress, notes, line selection, question queue, agent presence, and a readiness gate.
- One concise repository-aware description per review item: **What this change does** for diff reviews or **What this code section does** for scoped reviews.
- Durable local review workspaces with immutable revisions and safe carry-forward of unchanged review items.
- Reconnection by review reference from a fresh Claude Code or Codex task without relying on conversation history.
- Deterministic parsing, persistence, fingerprinting, reconciliation, and schema validation in code; agent reasoning is limited to grouping, code-section selection, descriptions, and answers.

## Non-goals

- Vouch integration.
- Reusing Synergy specification phases or execution-state journals for reviews.
- Storing review data as MDX.
- A standalone generated `.html` file. The existing Vite daemon renders the durable artifacts.
- A revision-history UI for scoped reviews.
- Change-story maps, dependency visualizations, context-peek panels, focus-lens systems, or per-item history timelines.
- Long architectural essays for individual review items.
- Automatic code changes from the review UI. The browser asks questions and records review state; the agent discusses or acts only when explicitly requested.
- Cloud persistence, accounts, or remote collaboration in the first version.
- Custom ignore systems such as `.synergyignore` in the first version.

## Terminology

### Review workspace

A stable container for one review subject:

- `<repo>-pr-317`
- `<repo>-staged`
- `<repo>-unstaged`
- `<repo>-scope-<scope-hash>`

### Review revision

An immutable snapshot of the exact source being reviewed. A workspace can contain multiple revisions as its PR, index, worktree, or scoped source changes.

### Review item

The smallest independently checkable piece:

- A diff hunk for PR, staged, and unstaged reviews.
- A meaningful code section for scoped reviews, such as a function, hook, component, class, configuration block, or whole file when no smaller boundary is useful.

### Review group

A manageable collection of related files or review items used for navigation. Groups are not Synergy phases and carry no execution semantics.

## Architecture

Review is a dedicated domain inside the existing Synergy application.

```text
Natural-language request or /synergy-review
                │
                ▼
        synergy:review skill
  intent, repository analysis, concise descriptions
                │
                ▼
        synergy review CLI
 capture, parse, fingerprint, persist, reconcile, validate
                │
                ▼
   .synergy/reviews/<workspace>/
                │
                ▼
       Existing Vite daemon
 /r/<workspace>/<revision> + HTTP + SSE
```

### Package boundaries

- `packages/review-core`: domain types, schemas, unified-diff parsing, source manifests, fingerprints, revision reconciliation, readiness calculation, and local artifact storage. It has no React or agent behavior.
- `packages/cli`: `synergy review ...` commands, Git/GitHub source capture, preview startup/opening, foreground question wait, and daemon fallback.
- `packages/preview`: review routes, review shell, diff/source rendering, review state, question UI, HTTP middleware, SSE, and agent-presence display.
- `skills/review/SKILL.md`: intent resolution, repository-wide analysis, grouping, code-section selection, description generation, question answering, and reconnect loop.
- `commands/synergy-review.md`: thin Claude Code command that dispatches to the shared skill. The root skill remains usable by Codex without a separate implementation.

The existing `packages/preview/src/theme.css` remains the single visual token source. Review CSS consumes `--syn-*` tokens and introduces no independent palette.

## Local persistence

```text
.synergy/
├── active-review.json
└── reviews/
    └── <workspace-id>/
        ├── workspace.json
        └── revisions/
            └── <revision-id>/
                ├── snapshot.json
                ├── insights.json
                ├── progress.json
                ├── questions/
                └── answers/
```

- `workspace.json`: repository identity, source kind, source selector, current revision, and timestamps.
- `snapshot.json`: immutable source metadata, parsed files, review items, lines, and fingerprints.
- `insights.json`: review groups, concise descriptions, confidence, and internal evidence paths.
- `progress.json`: reviewed, carried-forward, stale, and needs-review states; notes; navigation; and completion status.
- `questions/`: durable browser-to-agent requests tied to one immutable revision.
- `answers/`: durable agent responses tied to question and revision IDs.
- `active-review.json`: per-machine pointer updated by browser activity.

`.synergy/reviews/` and `.synergy/active-review.json` are gitignored by default. An explicit Markdown export is the shareable artifact.

All mutable files use atomic temporary-write-and-rename behavior. Immutable snapshot files are never rewritten after successful creation.

## Identity and revisions

The user-facing reference combines workspace and revision:

```text
mobile-app-pr-317@696cf4a-15f28a9
mobile-app-staged@a82c19f
mobile-app-unstaged@34bd81c
mobile-app-scope-subscriptions@7ac119e
```

- PR revisions include exact base/head metadata and a normalized snapshot fingerprint.
- Staged and unstaged revisions use a normalized source fingerprint.
- Scoped revisions use the selected manifest and exact eligible file contents.

Running the same review request against an identical snapshot resumes the existing revision. A changed snapshot creates a new immutable revision in the same workspace.

## Source inclusion rules

Git is the source of truth. Synergy does not manually reinterpret `.gitignore`.

| Source | Included content |
|---|---|
| PR | Every file in the PR diff |
| Staged | Every file in the Git index diff, including force-added files |
| Unstaged | Tracked modifications plus non-ignored untracked files |
| Scope | Tracked files plus non-ignored untracked files within the requested scope |
| Repository analysis | The same eligible tracked and non-ignored file set |

The eligible manifest is derived with standard Git semantics such as `git ls-files --cached --others --exclude-standard`. Binary and unreadable files appear in change metadata when relevant but are not sent through text-section analysis.

For scoped reviews, the skill resolves natural language into explicit paths/globs, then presents the resulting file and line counts before analysis. Gitignored untracked content, dependency/vendor directories represented by ignore rules, and binary files do not count toward the review scope.

## Capture and creation workflow

Supported triggers:

```text
/synergy-review --pr 317
/synergy-review --pr https://github.com/org/repo/pull/317
/synergy-review --staged
/synergy-review --unstaged
/synergy-review --scope features/subscriptions
/synergy-review --resume <workspace@revision>
```

Natural-language requests such as “review the subscription module” dispatch to the same skill.

Creation proceeds as follows:

1. Resolve the repository root and requested source.
2. Capture the exact source and eligible manifest.
3. Calculate its immutable revision fingerprint.
4. Resume an identical revision or create a new one.
5. Parse diff hunks or propose scoped code sections.
6. Validate every review-item range and fingerprint against the snapshot.
7. Analyze related items in batches using repository-wide context.
8. Validate `insights.json` against its schema.
9. Start the existing preview daemon and open the review URL.
10. Enter the foreground question-wait loop when requested.

Large scopes are processed incrementally by group so the first group can become reviewable before all descriptions finish. The UI exposes preparation status and never presents a partially analyzed item as complete.

## Repository-aware description contract

Each review item has one concise description:

- Diff review: **What this change does**.
- Scoped review: **What this code section does**.

The description explains the item’s role in the application, not a literal paraphrase of syntax. Before writing it, the agent examines the containing file/module, imports, exports, call sites, related hooks/stores/providers, relevant types/configuration, tests, and nearby implementation patterns.

Example:

```text
Weak: Changes the background color to primarySurface.

Required: Makes PlanCardToggle use the nutrition-plan surface token so its
elevation renders consistently on Android without changing the card hierarchy.
```

The normal output is one sentence and may use two when essential for accuracy. The artifact retains confidence and evidence paths for validation, but the normal UI displays only the concise description. When repository context is insufficient, the agent marks low confidence rather than inventing purpose.

```ts
interface ReviewItemInsight {
  reviewItemId: string;
  description: string;
  confidence: 'high' | 'medium' | 'low';
  evidencePaths: string[];
}
```

## Review reconciliation

Prior human reviews remain immutable historical facts. A new revision derives current coverage by referencing, not copying, the previous approval.

```ts
interface CarriedReview {
  status: 'carried-forward';
  inheritedFrom: {
    revisionId: string;
    reviewItemId: string;
  };
  verifiedFingerprint: string;
}
```

| New revision condition | Current result |
|---|---|
| Exact content and structural context unchanged | Carried forward |
| Only line numbers shifted | Carried forward |
| Selected content changed | Needs review |
| Same content moved to a different semantic context | Needs review |
| Item removed | Historical, not applicable |
| New item | Needs review |
| Mapping uncertain or duplicated | Stale/ambiguous; never guess |
| Unrelated file/item changed | Existing review remains valid |

One changed hunk makes its file and overall review incomplete without invalidating unrelated reviewed hunks.

Reconciliation occurs when creating/refreshing a workspace or resuming by workspace ID. Resuming an exact `<workspace>@<revision>` reference opens that immutable snapshot without creating a new revision. Browser reload, question waiting, and answer submission never reconcile implicitly.

If local source changes while a review is open, the browser displays **Source changed — refresh to reconcile a new revision**. It does not silently replace the user’s current view.

## Review interface

The review portal preserves the successful one-off layout while adopting Synergy’s design system.

```text
┌──────────────────────────────────────────────────────────────┐
│ Source · revision · freshness · progress · theme             │
├──────────────┬──────────────────────────────┬────────────────┤
│ Groups/files │ Diff or full source          │ Questions      │
│ Progress     │ What this item does          │ Agent status   │
│              │ Review · note · ask          │ Answers        │
└──────────────┴──────────────────────────────┴────────────────┘
```

### Diff reviews

- Guided group navigation and a complete file matrix.
- File and hunk checkboxes.
- Diff lines with old/new numbers and selection.
- One repository-aware **What this change does** description per hunk.
- Private hunk note.
- Mark hunk/file reviewed.
- Basic file search and keyboard shortcuts (`J/K`, `R`, `?`).

### Scoped reviews

- File/module hierarchy on the left.
- Full source in the center, divided into reviewable code sections.
- One repository-aware **What this code section does** description per section.
- The same line selection, notes, review controls, questions, and readiness behavior.
- No source-history interface; the current codebase state is the product view.

### Agent visibility

The question rail exposes: **Not listening**, **Listening**, **Question queued**, **Processing**, **Answered**, and **Connection interrupted**. Browser actions report success only after durable persistence.

## Browser-to-agent communication

Question lifecycle:

```text
Draft → Queued → Claimed/processing → Answered
                          ├── Failed, retryable
                          └── Stale source
```

Every question stores workspace/revision, file, review item, selected lines, complete item context, repository-aware description, question text, timestamp, and status.

The browser persists a question through the local daemon. The CLI waits through:

```text
synergy review wait <workspace@revision> --for 15m
```

Queued questions return immediately; otherwise the foreground command waits on the durable queue and maintains an agent-presence heartbeat. The skill answers through a schema-validated command/daemon endpoint equivalent to:

```text
synergy review answer <question-id> --body-file <path>
```

Answers are persisted before the daemon emits SSE updates to the browser. When the daemon is unavailable, CLI/file persistence remains authoritative.

Question claims are atomic. A claim has a listener identity and lease so two agents cannot process the same question simultaneously; an interrupted claim returns to the queue after expiry.

Question state transitions use an append-only generation log rather than a mutable lock file. Each generation contains the complete authoritative question state, claim token/lease, predecessor generation, and predecessor hash; contenders atomically publish the same next generation number, and only one can win. Losers rescan and revalidate before retrying. This fences suspended or expired owners without stale-lock deletion or ABA races. The canonical question JSON remains the immutable request envelope, answers remain separate immutable JSON records, and `ReviewStore.readBundle()` hydrates current status from the highest complete generation. A durable answer that outlives its claimant is reconciled into an answered generation independently of a new caller's identity or body.

## Reconnection

A fresh task runs:

```text
/synergy-review --resume <workspace@revision>
```

The skill loads the exact local artifacts, reports progress and freshness, processes queued questions, then re-enters the foreground wait loop. Conversation history is not required because questions contain their exact source context and the immutable snapshot remains on disk.

If only a workspace ID is supplied, the skill refreshes/resolves its latest current revision. An exact workspace+revision reference never silently advances.

## CLI surface

The planned command family is:

```text
synergy review create
synergy review refresh
synergy review list
synergy review open
synergy review status
synergy review wait
synergy review answer
```

The implementation plan may introduce a schema-validated internal command for applying agent-produced groups/descriptions. It is not a primary user-facing workflow.

## Readiness

A current revision is ready only when:

1. Every review item is explicitly reviewed or safely carried forward.
2. No current item is stale or ambiguously reconciled.
3. Every queued question is answered.
4. The displayed revision is still the current known source snapshot.

Removed historical items do not block readiness. A changed review item immediately returns its file and overall review to incomplete.

## Error handling

| Scenario | Behavior |
|---|---|
| Not a Git repository | Explain that a Git-backed source is required; create nothing |
| PR unavailable or GitHub auth missing | Preserve no partial revision; show exact corrective action |
| Empty staged/unstaged source | Report no changes; do not create an empty review |
| Empty scope | Show resolved manifest and ask for a corrected scope |
| Excessively broad scope | Show counts and require explicit confirmation before analysis |
| Malformed artifact | Refuse mutation, preserve original, and report the path/schema error |
| Source changes during review | Keep current snapshot visible and prompt for refresh |
| Ambiguous reconciliation | Mark affected item stale; never carry it forward |
| Preview daemon unavailable | Continue through CLI/file fallback; report browser unavailability |
| Question wait interrupted | Preserve queue and release/expire claim |
| Answer generation fails | Keep question retryable with visible failure status |
| Browser closes | Preserve all applied review progress, questions, and answers |

## Testing strategy

### Review-core unit tests

- Unified diff parsing, including additions, deletions, renames, binary metadata, and no-final-newline cases.
- Stable workspace IDs and immutable revision IDs.
- Idempotent recreation of an identical snapshot.
- Hunk and code-section fingerprint validation.
- Carry-forward for exact content/context with line shifts.
- Needs-review for changed content or semantic movement.
- New, removed, and ambiguous review-item handling.
- Readiness derivation.
- Git-standard eligible manifest behavior.

### CLI integration tests

Use temporary Git repositories to cover:

- Staged, unstaged, and untracked capture.
- Ignored untracked exclusion and tracked-file inclusion.
- Create, refresh, resume, list, open, and status.
- Exact-revision resume versus workspace refresh.
- Durable wait/answer flow and daemon fallback.
- Atomic question claims and lease expiry.
- Corrupt/partial artifact refusal.

GitHub PR capture uses fixtures/mocked command execution for deterministic tests and a documented manual authenticated smoke test.

### Preview tests

- Review routes and unknown-review states.
- Group/file navigation and progress.
- Diff and full-source rendering.
- Item/file review controls.
- Concise repository-aware description display and confidence state.
- Line selection, question creation, persistence confirmation, and answers.
- SSE presence and answer updates.
- Readiness blocking for unreviewed, stale, changed, and unanswered states.
- Keyboard and focus behavior.
- Theme-token use in light and dark modes.

### End-to-end scenarios

1. Create a staged review, ask from selected lines, receive an agent answer, and complete the review.
2. Modify one reviewed hunk, refresh, carry unchanged hunks forward, and reopen only affected coverage.
3. Resume an exact revision from a fresh agent task and process queued questions.
4. Create a scoped module review, verify ignored content is absent, review code sections, and complete it.

Repository gates:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Implementation sequencing and subagents

Shared schemas and contracts land first. Implementation then divides across bounded package ownership:

1. **Review-core agent:** types, schemas, parsing, manifests, fingerprints, persistence, reconciliation, and core tests.
2. **CLI/communication agent:** command surface, capture adapters, question queue, claim leases, polling, daemon handlers, and integration tests.
3. **Preview agent:** routes, shell, diff/source viewers, progress, questions, answers, readiness, and tokenized styling.
4. **Skill/documentation agent:** shared skill, Claude command, repository-analysis contract, reconnect loop, and docs.
5. **Primary agent:** shared contracts, integration, conflict resolution, end-to-end scenarios, regression review, and final quality gates.

Agents work on disjoint package surfaces after the shared model is fixed. No agent commits or pushes. The primary agent owns verification and presents the integrated changes for explicit user approval before any commit.

## Acceptance criteria

- [ ] A user can trigger PR, staged, unstaged, and scoped reviews from Claude Code or Codex.
- [ ] An identical request resumes the same revision; changed source produces a new revision in the same workspace.
- [ ] Reviews are split into manageable diff hunks or code sections.
- [ ] Every review item has a concise description grounded in repository-wide context.
- [ ] Review progress persists locally and changed items alone return to needs-review.
- [ ] Gitignored untracked content is excluded according to standard Git semantics.
- [ ] The review UI uses Synergy’s Ember & Graphite tokens and preserves light/dark behavior.
- [ ] Selected-line questions reach a listening agent without clipboard transfer.
- [ ] Answers persist and appear in the browser; agent interruption does not lose questions.
- [ ] A fresh task can resume by exact review reference without prior conversation history.
- [ ] The readiness gate prevents completion with unreviewed/stale items or unanswered questions.
- [ ] Scoped reviews present current source without a history-oriented UI.
- [ ] Typecheck, lint, tests, and production build pass.
