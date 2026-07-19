# Review Performance Hardening Design

**Status:** Approved for implementation planning  
**Date:** 2026-07-19  
**Repository:** `sanzhardanybayev/synergy`  
**Baseline:** `origin/main` at `2b8580c` (merged PR #21)  
**Deferred automation:** [Issue #22](https://github.com/sanzhardanybayev/synergy/issues/22)

## Problem

The first whole-module dogfood of Synergy Review exposed three independent delays and one misleading success state:

1. Claude Code installed plugin `0.12.0` into a fresh versioned cache without committed runtime `dist` files. The CLI failed with `MODULE_NOT_FOUND`, forcing `pnpm install` and a full workspace build before review could begin.
2. A 15-file, 3,035-line TypeScript scope produced 64 review sections. The agent had to read Review Core exports, write a 233-line helper script, derive opaque item IDs with `applyCodeSections`, and emit a 1,061-line analysis payload.
3. Preview startup used a project-local PID file with a globally fixed port. A different process held port `4321`; Synergy wrote a PID and printed success before Vite failed, leaving the user with a dead URL.
4. The workflow did not report trustworthy phase durations, so the agent described the analysis as approximately ten minutes even though the persisted snapshot-to-finalized-bundle interval was 3 minutes 28 seconds.

The current product makes the agent perform deterministic bookkeeping that belongs in the CLI, and it treats process creation as equivalent to runtime readiness.

## Outcome

Deliver two additive pull requests:

1. **Runtime and distribution reliability (`0.12.1`)** — remove plugin rebuilds, make preview startup truthful and multi-project-safe, return a complete healthy URL, and expose runtime timing.
2. **Analysis efficiency (`0.13.0`)** — remove the circular opaque-ID contract, guide useful scope granularity, enforce full captured-line coverage, and expose time-to-review-ready.

The larger AST-guided and parallel semantic-analysis pipeline remains separate in issue #22.

## Success Metric

The primary metric is **warm time-to-review-ready**.

The timer starts when the user invokes a review command against an already installed plugin with dependencies present. It stops when:

- the immutable source has been captured;
- review units and repository-aware descriptions are finalized;
- the bundle is persisted;
- the preview runtime has passed a project-identity health check; and
- the user receives a complete working review URL.

For a representative TypeScript scope of approximately 15 files and 3,000 lines:

- five warm dogfood runs must have a median of at most 210 seconds;
- no run may exceed 240 seconds;
- the recommended semantic-unit target is approximately 20–30 items;
- all measurements must report capture, agent-analysis interval, publication, and preview-readiness separately.

This is not a four-minute human-review limit and not a per-unit budget.

## Global Constraints

- Preserve immutable source snapshots, canonical item identity, reconciliation, readiness, and durable questions from PR #21.
- Never expose content/location hash implementation details to an agent.
- Repository-aware descriptions remain agent-authored and must explain application purpose, not syntax.
- Analysis publication remains one validated atomic operation; partial analysis must never appear finalized.
- Tracked or force-added ignored files remain eligible; ignored untracked files remain excluded through Git.
- Do not commit `node_modules` or platform-specific package-manager binaries.
- Keep Node.js `>=20`, pnpm `10.28.2`, ESM output, and the current Git-relative Claude plugin marketplace.
- Version synchronization continues to derive marketplace and skill stamps from `.claude-plugin/plugin.json`.

---

## PR 1: Runtime and Distribution Reliability

### Distribution contract

The Claude marketplace uses `source: "./"`, so each plugin version is a copy of Git-tracked repository content. Package `files` declarations do not affect that copy. Runtime artifacts required before build must therefore be committed.

Track complete deterministic output trees for:

- `packages/cli/dist/**`
- `packages/review-core/dist/**`
- `packages/spec-kit/dist/**`
- `packages/state/dist/**`
- `packages/validator/dist/**`

If the preview runtime introduces an additional compiled child entry inside `packages/cli/dist`, it is covered by the same tree. Do not commit `packages/preview/dist/**` unless the implementation changes the runtime to consume it.

`/synergy-setup` becomes dependency-install-only:

```bash
pnpm install --frozen-lockfile
node packages/cli/dist/cli.js --help
```

It must not invoke `pnpm build`, `tsup`, or `vite build`.

This PR eliminates the rebuild. It does not claim zero-touch installation: a fresh Git-backed plugin cache still needs its locked runtime dependencies. A future npm-based plugin distribution may remove that remaining installation step.

### Artifact guard

Add one canonical manifest of required runtime entrypoints and output roots. The release gate must:

1. verify required artifacts exist and are tracked before building;
2. rebuild runtime packages;
3. fail on modified, deleted, or newly generated files under tracked output roots;
4. detect the non-static `review-core` source-capture worker;
5. reject tracked `node_modules` paths; and
6. run a clean `git archive HEAD` smoke test without building.

The archive smoke test installs frozen dependencies, preserves artifact checksums, runs CLI help and validation, creates a staged review in a temporary Git fixture, starts a healthy preview, performs an HTTP request, and stops the preview. It runs on Ubuntu and macOS.

### Preview runtime model

Port `4321` becomes a preferred port, not a global invariant.

- With no explicit `--port`, startup may select the next available loopback port.
- With explicit `--port N`, startup is strict and returns nonzero when occupied.
- Success is printed only after an HTTP health check proves the runtime belongs to the expected canonical project and launch instance.
- Same-project concurrent starts serialize and resolve to one runtime.
- Different projects may run simultaneously on different ports.

Replace `.synergy/preview.pid` as the authority with `.synergy/preview.runtime.json`:

```json
{
  "schemaVersion": 1,
  "protocolVersion": 1,
  "state": "ready",
  "instanceId": "uuid",
  "projectId": "sha256:canonical-root-hash",
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 4322,
  "origin": "http://127.0.0.1:4322",
  "preferredPort": 4321,
  "strictPort": false,
  "startedAt": "2026-07-19T16:00:00.000Z",
  "controlToken": "random-256-bit-token",
  "toolVersion": "0.12.1"
}
```

The file is written atomically with mode `0600`. `origin` is always derived from a validated loopback host and port; it is never trusted as arbitrary persisted input.

Add two loopback-only runtime routes:

- `GET /api/runtime/health` returns protocol, instance, project identity, PID, and readiness without exposing the project path or control token.
- `POST /api/runtime/shutdown` requires the control token and matching instance identity.

The CLI may use a compiled child launcher to call Vite programmatically and learn the actual bound port. The parent waits for a bounded ready message and then performs an independent HTTP health check before publishing runtime metadata.

### Preview lifecycle

Startup phases are:

```text
lock → launch → configure → bind → listen → child health → publish runtime → parent health → ready
```

Each launch has an `attemptId` and monotonic duration measurements. A failed attempt reports the failed phase and a bounded log tail.

Failure rules:

- Child exit, timeout, bind failure, or identity mismatch returns nonzero and never prints success.
- Cleanup removes only lock/runtime state owned by the current attempt.
- An unverified legacy or reused PID is never killed.
- Stop uses the authenticated shutdown route, verifies the instance disappeared, then removes runtime metadata.
- Stop completes within three seconds or reports that the runtime remains alive.

Legacy `.synergy/preview.pid` handling:

- dead or malformed PID: remove it;
- alive PID: preserve it, but do not adopt or signal it. Legacy metadata has no authenticated control token, so fabricating a new runtime record would make verified shutdown impossible. A future adoption flow requires an authenticated proof/handshake;
- alive PID without matching identity: leave the process untouched, remove no external state, and start this project on another port.

### URL authority

`preview status --json` returns the healthy runtime origin and timing state. `review open` uses that origin and returns a complete URL:

```text
http://127.0.0.1:4322/r/<workspace>/<revision>
```

Skills and commands must stop constructing or promising `localhost:4321` URLs. A relative review route remains useful internally, but it is not a user-facing ready URL.

`review open` does not start the runtime implicitly. When no matching healthy runtime exists, it returns a typed nonzero `preview_not_ready` result with the exact rooted `preview start` corrective action. This keeps runtime mutation explicit and prevents a relative route from being presented as usable.

### PR 1 acceptance

- A Git archive contains every declared runtime artifact before installation.
- Frozen dependency installation followed by CLI/review/preview smoke tests succeeds without any build command.
- Rebuilding produces no artifact drift, including untracked hashed chunks.
- Removing any declared entrypoint or `source-capture-worker.js` fails the artifact gate.
- Default startup with `4321` occupied selects a reachable alternate port.
- Explicit startup on an occupied port fails and prints no success marker.
- Five concurrent projects receive five unique reachable origins.
- Concurrent starts for one project create exactly one runtime.
- Status/start for an already healthy runtime completes within 250 ms locally.
- Cold local preview startup p95 is below three seconds; failure is bounded to ten seconds.
- Stop cannot terminate an unrelated or identity-mismatched process.
- No hardcoded user-facing runtime origin remains.
- Full typecheck, lint, tests, build, version-sync, archive smoke, Linux smoke, and macOS smoke pass.

---

## PR 2: Analysis Efficiency

### Root contract change

`review analysis-set` already calls `applyCodeSections` internally. The current payload nevertheless requires opaque derived IDs before submission, creating a circular dependency.

Keep the existing command and change only the scoped payload. Diff payloads retain their existing review-item-ID contract.

Scoped sections receive agent-local keys and carry their own insight:

```json
{
  "groups": [
    {
      "id": "capture",
      "label": "Event capture",
      "sectionKeys": ["webhook-capture", "projection-dispatch"]
    }
  ],
  "sections": [
    {
      "key": "webhook-capture",
      "path": "src/subscription/subscription.service.ts",
      "label": "Webhook capture",
      "parentLabel": "SubscriptionService",
      "start": 118,
      "end": 160,
      "description": "Durably records a RevenueCat event before applying its projection so projection failures cannot lose the raw event.",
      "confidence": "high",
      "evidencePaths": [
        "src/subscription/subscription.service.ts",
        "src/subscription/revenuecat-event.repository.ts"
      ]
    },
    {
      "key": "projection-dispatch",
      "path": "src/subscription/subscription.service.ts",
      "label": "Projection dispatch",
      "parentLabel": "SubscriptionService",
      "start": 161,
      "end": 196,
      "description": "Routes captured RevenueCat event types to their projection handlers while leaving unsupported events replayable.",
      "confidence": "high",
      "evidencePaths": ["src/subscription/subscription.service.ts"]
    }
  ]
}
```

The CLI:

1. strictly parses the scoped contract and rejects unknown properties;
2. separates structural section fields from insight fields;
3. calls `applyCodeSections` once;
4. zips returned items to unique local keys in proposal order;
5. translates `sectionKeys` into durable `reviewItemIds`;
6. constructs the existing durable `ReviewInsights` model;
7. runs existing semantic and relationship validation; and
8. atomically finalizes the immutable revision.

Local keys are input aliases only. They are never persisted as canonical identity or used for reconciliation.

Successful `analysis-set --json` output includes:

```json
{
  "reference": "workspace@revision",
  "analysisFinalized": true,
  "reviewItemCount": 26,
  "groupCount": 8,
  "withinRecommendedRange": true,
  "analysisFinalizedInMs": 198000,
  "route": "/r/workspace/revision",
  "previewReady": false
}
```

Analysis finalization never depends on preview availability. When a matching healthy runtime already exists, the output may additionally include its complete `url` and set `previewReady: true`. Otherwise the skill starts preview and calls `review open`; the final ready output from those commands establishes time-to-review-ready.

### Adaptive guidance

`review create --json` and `review status --json` include `analysisGuidance`.

For scoped reviews:

```text
minimum = max(textFiles, min(30, ceil(lines / 150)))
target  = max(textFiles, min(30, ceil(lines / 120)))
maximum = max(textFiles, min(30, ceil(lines / 100)))
scopeTooBroad = textFiles > 30 || lines > 4500
```

For the incident scope, this is exactly `21 / 26 / 30`.

The range is soft semantic guidance, not a persistence constraint. The agent may deviate when meaningful boundaries justify it, but must state the reason. When `scopeTooBroad` is true, the skill asks the user to narrow the scope instead of manufacturing oversized units.

Diff guidance reports its deterministic captured item count because diff hunks already exist.

### Coverage and validation

Every captured line in every non-binary scoped file must belong to exactly one proposed section.

- No leading, middle, or trailing gaps.
- No overlaps.
- Blank and trailing lines may be assigned to an adjacent semantic unit.
- Binary files require no sections.
- Every local key is unique and safe.
- Every section key appears in exactly one group.
- Every section carries exactly one valid description, confidence value, and non-empty unique captured evidence set.
- Description length remains at most 600 characters.
- Existing path, range, duplicate-identity, freshness, locking, conflict, and immutable-publication rules remain authoritative.
- Any error leaves the revision unfinalized and the pending artifacts unchanged.

The JSON Schema owns the strict structural envelope, while the parser additionally enforces
cross-reference ownership and uniqueness that JSON Schema cannot express. The parser may not
silently discard unknown properties that the schema forbids.

### Skill behavior

The review skill no longer instructs the agent to:

- read Review Core exports;
- import `@synergy/review-core`;
- call `applyCodeSections` directly;
- write a temporary helper JavaScript program; or
- infer opaque durable IDs.

The agent still reads relevant repository context, selects semantic boundaries, creates concise application-role descriptions, marks uncertainty, and writes one temporary JSON payload.

For tests and repetitive declarations, the skill prefers coherent behavioral units over one item per test case. Semantic usefulness wins over the arithmetic target.

### Timing visibility

Persisted snapshot creation and analysis finalization establish the authoritative agent-analysis interval. CLI output additionally reports its own monotonic parsing, derivation, validation, publication, and preview-resolution durations.

The user sees at least:

```text
captured 15 files / 3,035 lines
recommended 21–30 review units (target 26)
analysis finalized: 26 units in 198.0s
preview ready: http://127.0.0.1:4322/...
```

The CLI does not pretend to know sub-step progress inside the model. Fine-grained parallel worker progress belongs to issue #22.

### PR 2 acceptance

- The incident fixture returns exactly `21 / 26 / 30` guidance.
- One scoped `analysis-set` invocation derives canonical IDs and finalizes the revision.
- No skill or E2E fixture imports Review Core to precompute scoped review IDs.
- No helper JavaScript is required; only a temporary analysis JSON payload is produced.
- Every captured text line is covered exactly once.
- Unknown fields, invalid keys, gaps, overlaps, unsafe paths, invalid evidence, duplicate grouping, and repeated publication fail without finalization.
- Status immediately reports `analysisRequired: false` after success.
- The skill produces approximately 20–30 useful units for the incident fixture unless documented semantic complexity justifies a deviation.
- Five warm dogfood runs have median time-to-review-ready at most 210 seconds and maximum at most 240 seconds.
- Typecheck, lint, CLI/review-core/preview/plugin-guard tests, build, and version-sync pass.

---

## Implementation Fan-Out

All subagents work in isolated worktrees or in mutually exclusive file ownership. Subagents never commit or push unless the root explicitly delegates that action after repository-rule review. The root owns integration, shared version files, final commits, pushes, and PR creation.

### PR 1 parallel wave

| Owner | Scope | Exclusive files |
|---|---|---|
| Packaging agent | Artifact manifest, drift checker, archive smoke, CI wiring | `.gitignore`, `packages/plugin-guard/src/*artifact*`, `packages/plugin-guard/tests/artifacts.test.ts`, packaging scripts |
| Preview-server agent | Runtime health/control middleware and child launcher contract | New preview runtime modules and focused preview tests |
| CLI-runtime agent | Runtime metadata, start lock, dynamic port, migration, status/open/stop | `packages/cli/src/preview*.ts`, `paths.ts`, focused CLI tests |
| Root integrator | Resolve contracts, docs, skills, version bump, generated `dist`, aggregate verification | Shared manifests/docs/version stamps and integration tests |

The agents receive the runtime JSON and health-response contracts from this spec. If a proposed change requires an owned file from another task, the agent reports the dependency instead of editing across the boundary.

### PR 2 parallel wave

| Owner | Scope | Exclusive files |
|---|---|---|
| Analysis-contract agent | Strict scoped parser, local-key translation, atomic finalization | `review-cli.ts`, scoped portions of `review-actions.ts`, focused tests |
| Guidance agent | Pure arithmetic guidance and full-line coverage helpers | New `review-analysis-guidance.ts` / `review-coverage.ts` modules and unit tests |
| Skill-contract agent | JSON schema, skill instructions, plugin-guard assertions, documentation | `skills/review/**`, `packages/plugin-guard/tests/review-skill.test.ts`, command docs |
| Root integrator | Wire helpers, E2E, timings, version bump, dogfood, aggregate verification | Shared exports/fixtures/version stamps and integration tests |

PR 2 is developed as a stack on PR 1 so it can consume the complete healthy runtime URL. After PR 1 merges, PR 2 is rebased or retargeted to `main` without changing its behavior.

## Baseline and Regression Policy

The clean merged baseline currently has one known filesystem-watcher failure:

- `packages/preview/tests/server/feedback-stream.test.ts`: change-frame wait may time out in the temporary-worktree environment.

That failure is outside these PRs. New runtime tests must use event/health conditions rather than arbitrary sleeps. Neither PR may introduce additional failures or hide the baseline exclusion.

## Deferred Work

Issue #22 owns:

- language-aware AST adapters;
- complexity/token-weighted structural discovery;
- import/call-graph grouping;
- generated/vendor/test classification;
- deterministic parallel semantic workers;
- retry, cancellation, concurrency limits, and partial worker progress;
- staged preparation with one atomic final publication; and
- multi-language performance benchmarks.

Neither near-term PR adds an AST dependency or a host-specific subagent API.
