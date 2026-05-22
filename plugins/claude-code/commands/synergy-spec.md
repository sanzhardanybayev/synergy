---
description: Create a new Synergy MDX spec session and auto-open the preview
argument-hint: <title> [--type feature|refactor|project]
---

Invoke the `create-spec` skill to author a new spec session.

The user's request: `$ARGUMENTS`

Follow the create-spec workflow:

1. Restate the request in one sentence and confirm the work type if ambiguous (feature / refactor / project).
2. Auto-generate the session name as `YYYY-MM-DD-<slug>` unless the user wants to override.
3. Run `synergy spec "<title>" --type <type>` from the project root. The CLI creates the session, starts the preview server on port 4321, and opens the browser.
4. Replace placeholder text in the generated MDX files with real content. Use spec-kit components (`<Status>`, `<Phase>`, `<Timeline>`, `<SubSpec>`, `<CrossRef>`, `<AgentAllocation>`, `<OpenQuestion>`, `<Risk>`, `<Chart>`, …) — see the create-spec skill for the full cheat sheet.
5. Write `orchestrator.md`: dependency graph, parallel chunks, sub-agent vs team strategy, verification gates.
6. Run `synergy validate <session-name>` and resolve any errors.
7. Confirm the spec reflects the user's intent.
