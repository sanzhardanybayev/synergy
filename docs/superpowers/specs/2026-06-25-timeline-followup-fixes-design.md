# Live-timeline follow-up fixes

**Status:** Design · 2026-06-25 · follow-up to [phase-driven-live-timeline](2026-06-25-phase-driven-live-timeline-design.md) (PR #12)

Two non-blocking items surfaced in the final whole-branch review. This is a short spec for handling each.

## Fix 1 — Validator title regex is not CRLF-tolerant *(implement)*

**Problem.** `hasFrontmatterTitle` in `packages/validator/src/phase.ts` matches the frontmatter block with `/^---\n([\s\S]*?)\n---/`. On a `spec.mdx` saved with CRLF (`\r\n`) line endings the opening fence is `---\r\n`, so the regex fails to match the block and the validator emits a spurious "missing `title`" **warning** — even though the title is present and the server's `gray-matter`-based `readPhaseTitle` parses it correctly. The two title parsers disagree only on CRLF.

**Severity.** Low — every in-tree writer emits `\n`, so this only bites a hand-edited/Windows-saved file. Warning-only; never blocks a build.

**Fix.** Make the validator's frontmatter parse CRLF-tolerant so it agrees with the server:
- Block extraction: `/^---\r?\n([\s\S]*?)\r?\n---/`.
- Title line: `/^title:\s*\S/m` already works on `\r\n` (`\s` includes `\r`); no change needed there, but verify.

**Test.** Add a case to `packages/validator/tests/phase.test.ts`: a phase `spec.mdx` written with `\r\n` line endings and a valid `title:` must produce **no** missing-title warning. (Mirror the existing LF "title present → no warning" case.)

**Scope.** One regex change + one test. Rebuild `@synergy/validator` dist afterward (it is consumed compiled).

## Fix 2 — Duplicate initial payload on mount *(won't-fix)*

**Observation.** `ProgressProvider` calls `load()` eagerly **and** opens the `EventSource`, whose server handler sends an initial frame on connect — so the first paint receives two identical payloads.

**Decision.** Leave as-is. Both writes set the same state idempotently (harmless), and the eager `load()` guarantees a fast first paint on the no-SSE fallback path; removing it would *worsen* fallback latency. Optionally add a one-line comment in `ProgressProvider.tsx` noting the double-paint is intentional. No test.

## Out of scope (already documented as accepted limitations)

CLI `synergy status` still uses the legacy derivation; recursive `fs.watch` is macOS/Windows only (Linux falls back to poll); renaming a phase slug after it is marked done orphans that status. These remain as stated in the parent design.
