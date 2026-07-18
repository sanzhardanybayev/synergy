# Synergy design system - "Ember & Graphite"

The visual language of the Synergy preview app. One token layer drives every
surface: app chrome (`packages/preview/src/app.css`, `edit-ui.css`) and the
spec-kit component library (`packages/spec-kit/src/styles.css`). The tokens
live in `packages/preview/src/theme.css`; that file is the source of truth,
this document is the map.

## Identity

- **Accent: ember.** A warm copper-orange. Rare among developer tools (which
  cluster around blue, purple, and green) and a nod to the Claude ecosystem
  Synergy plugs into. Used sparingly: active nav, primary actions, dirty-state
  feedback, the brand mark.
- **Neutrals: warm graphite / warm paper.** Both themes are warm-tinted rather
  than blue-slate. Dark is the primary theme; light is a deliberate "paper"
  theme, not an inversion.
- **Brand mark.** Two overlapping rotated squares (one ember-filled, one
  outlined) - "two parts interlocking". Rendered by `SynergyMark` in
  `packages/preview/src/icons.tsx` and as the favicon in `index.html`.
- **Chart sheets.** Mermaid renders a fixed light palette, so charts sit on a
  light "spec sheet" panel in BOTH themes (`--syn-sheet-bg`). This is a
  feature, not a compromise: diagrams read like paper drawings pinned to the
  surface, and theme toggles never require a mermaid re-render.

## Color tokens

Light (`:root`) / Dark (`:root[data-theme='dark']`):

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--syn-accent` | `#c14f2c` | `#e0784f` | Primary actions, active nav |
| `--syn-accent-fg` | `#a83f20` | `#ef9871` | Accent-colored text on bg |
| `--syn-accent-contrast` | `#ffffff` | `#1c130e` | Text on accent fills |
| `--syn-on-fill` | `#ffffff` | `#161412` | Text on solid badge/status fills (aliased as `--sk-on-fill`) |
| `--syn-bg` | `#faf9f6` | `#161412` | App background |
| `--syn-bg-sunken` | `#f3f1ec` | `#11100e` | Sidebar |
| `--syn-bg-raised` | `#ffffff` | `#1d1b18` | Cards, drawers, panels |
| `--syn-bg-overlay` | `#ffffff` | `#23201c` | Popovers, composers |
| `--syn-fg` | `#211d18` | `#ece7df` | Primary text |
| `--syn-fg-muted` | `#5f584e` | `#a89f92` | Secondary text |
| `--syn-fg-subtle` | `#736b5d` | `#8a8172` | Micro-labels, icons |
| `--syn-border` | `#e6e2d9` | `#2b2823` | Hairlines |
| `--syn-border-strong` | `#d2ccc0` | `#403b33` | Hover borders, markers |

Status hues (`--syn-status-*`): draft gray, proposed violet, in-progress
amber, blocked red, done green, shipped cyan - tuned per theme for AA
contrast. Semantic aliases: `--syn-danger`, `--syn-success`, `--syn-warn`,
plus diff (`--syn-diff-*`) and comment-marker (`--syn-mark*`) tokens.

All text/background pairs meet WCAG AA (4.5:1) in both themes; verify with a
contrast checker when changing any of them.

## Typography

Self-hosted via `@fontsource-variable` packages (no network fetch):

- `--syn-font-display`: **Space Grotesk** - page titles, section headings,
  drawer titles, the wordmark. Tight tracking (`-0.02em`).
- `--syn-font-ui`: **Inter** - body and UI text.
- `--syn-font-mono`: **JetBrains Mono** - paths, session names, slugs, code,
  table headers, micro-labels (uppercase, `0.08em` tracking).

Scale (px): 11 / 12 / 13 / 14 / 15 (body) / 17 / 21 / 26. Line heights:
1.25 headings, 1.65 body. Numeric UI (counters, dates, stats) uses
`font-variant-numeric: tabular-nums`.

## Space, radius, elevation

- Spacing: 4px base scale (`--syn-sp-1` = 4 ... `--syn-sp-16` = 64).
- Radii: 4 / 6 / 8 / 12 / 16 / full (`--syn-radius-*`). Cards 12, controls 6-8,
  pills full.
- Shadows (`--syn-shadow-sm/md/lg/drawer`): soft and layered in light; deeper
  in dark, where 1px borders carry most of the structure.
- Sidebar 268px; content column max 860px; prose measure `72ch`.

## Motion

- Easings: `--syn-ease-out` (cubic-bezier(0.25, 1, 0.5, 1)) for entrances,
  `--syn-ease-in-out` for reversible state.
- Durations: 120ms hover, 180ms popovers, 260ms drawers.
- Everything collapses to ~0ms under `prefers-reduced-motion: reduce`
  (global override in theme.css).

## Theming mechanism

`index.html` resolves the stored preference (`localStorage["synergy-theme"]`,
absent = system) to a concrete `data-theme="light" | "dark"` on `<html>`
before first paint, and tracks system changes live. CSS only ever handles the
two concrete values - there is no media-query fallback by design. The
three-state toggle (`ThemeToggle.tsx`) lives in the sidebar footer.

Legacy variable names (`--app-*`, `--sk-*`) are aliased onto the token layer
at the bottom of theme.css so spec-kit and older rules shift theme together.
`packages/spec-kit/src/styles.css` duplicates the palette as fallbacks so the
package still renders standalone; keep the two in sync when changing tokens.

## Iconography

Inline stroke SVGs (Lucide-style geometry, 24px viewBox, 1.75 stroke,
`currentColor`) in `packages/preview/src/icons.tsx` and
`packages/spec-kit/src/components/icons.tsx`. No emoji glyphs in chrome; no
icon font; no external icon dependency.

## Interaction affordances

- Focus: global `:focus-visible` 2px ember outline, 2px offset.
- Editing: a focused contentEditable block shows a quiet gray left rail; once
  dirty it turns ember and the inline Apply/Discard row appears. The AgentTree
  signals dirty with an amber outline + pending dot.
- Primary buttons fill ember; secondary are ghost/bordered; destructive uses
  `--syn-danger` only on confirm affordances.
