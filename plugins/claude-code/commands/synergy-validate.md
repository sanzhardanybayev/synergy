---
description: Validate one or all Synergy spec sessions (schemas + cross-refs)
argument-hint: [session-name]
---

Run `synergy validate $ARGUMENTS` in the current project root.

The validator parses every `.mdx` file in `.synergy/sessions/`, checks component props against the spec-kit JSON schemas, and resolves every `<CrossRef to="...">` against the actual heading anchors in the session.

Exit code `0` = clean (warnings may be present). Exit `1` = errors that block the session from being considered valid.

If errors are reported, do not declare the spec ready. Fix them and re-run.
