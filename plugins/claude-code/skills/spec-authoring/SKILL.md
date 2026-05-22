---
name: spec-authoring
description: Use whenever editing or extending an existing Synergy spec session in .synergy/sessions/. Enforces spec-kit component usage, cross-reference discipline, and session-local component creation. Triggers when the user asks to "update the spec", "add a section to the design doc", "extend the architecture spec", or any edit to a `.synergy/sessions/**/*.mdx` file.
---

# spec-authoring

Rules for editing existing Synergy specs. The `create-spec` skill is for new sessions; this skill is for everything after.

## Where to edit

- All session content lives in `.synergy/sessions/<name>/`. Never write spec files outside this tree.
- Add new sub-specs as `NN-<slug>.mdx` where `NN` keeps numeric ordering. Cross-link with `<SubSpec>`.
- Put session-local React components in `_components/<Name>.tsx` and import them with a relative path from the MDX file.
- Put images in `assets/` and reference them via `<Mockup src="./assets/foo.png" alt="..." />`.

## Component usage

- Always prefer spec-kit components over raw markdown for structured content (status badges, phases, risks, allocations, timelines, charts).
- If the structure you need doesn't exist in spec-kit, build a session-local component in `_components/` rather than dropping back to ad-hoc markdown.
- Charts default to `<Chart>` (Mermaid). For visuals beyond Mermaid, import a chart library (recharts, visx, etc.) inside a session-local component.

## Cross-references

- Every link between specs in the same session **must** use `<CrossRef to="<slug>" />` or `<CrossRef to="<slug>#<anchor>" />`.
- Heading anchors are GitHub-style: lowercase, spaces → `-`, special chars stripped, deduplicated per file.
- After editing, run `synergy validate <session-name>` — dangling cross-refs are validation errors.

## Iterating with the preview

1. The preview server is at `http://localhost:4321/s/<session-name>`. Start it with `synergy preview start` if it isn't running.
2. On every save, MDX files hot-reload in the browser. Confirm the user can see your change before moving on.
3. When you add or delete a spec file, the virtual session index is rebuilt and the page does a full reload.

## Verification

Before declaring an edit complete:

```
synergy validate <session-name>
```

Zero errors. Warnings are OK (e.g. unparseable non-literal expressions in props) but should be reviewed.

## Don'ts

- Don't add files outside the session directory and claim they're part of the spec.
- Don't write raw markdown links between specs (`[link](01-architecture.mdx)`). Use `<CrossRef>`.
- Don't bypass the validator by silencing errors. If a CrossRef doesn't resolve, fix the target.
- Don't bundle implementation code into the spec — the spec describes the implementation, the agents implement it elsewhere.
- Don't edit `orchestrator.md` to be more MDX-like — it's plain markdown by design so it stays readable in CLI output.
