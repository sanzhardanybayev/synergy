import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedSpec } from './parse.js';
import type { ValidationIssue } from './types.js';

/** True when the file's leading frontmatter block declares a non-empty `title:`. */
function hasFrontmatterTitle(specPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(specPath, 'utf8');
  } catch {
    return false;
  }
  const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!fm) return false;
  return /^title:\s*\S/m.test(fm[1]!);
}

/** Slug constraints derived from the spec. */
const MAX_SLUG_LENGTH = 40;
const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PHASE_FOLDER_RE = /^(\d{2})-(.+)$/;

export interface PhaseFolder {
  /** Folder name as it appears on disk, e.g. "02-core". */
  folderName: string;
  /** Absolute path to the phase folder. */
  dir: string;
  /** Numeric prefix (parsed from `NN`), or `undefined` if malformed. */
  order: number | undefined;
  /** Kebab-case slug after the numeric prefix, or `undefined` if malformed. */
  slug: string | undefined;
  /** True when the folder name does NOT match `NN-<slug>`. */
  malformed: boolean;
}

/**
 * List `phases/*` folders under a session directory. Returns folders sorted by
 * numeric prefix (malformed entries last, in name order). Non-directory entries
 * under `phases/` are skipped. Returns `[]` if `phases/` does not exist.
 */
export function listPhases(sessionDir: string): PhaseFolder[] {
  const phasesDir = join(sessionDir, 'phases');
  let entries: string[];
  try {
    entries = readdirSync(phasesDir);
  } catch {
    return [];
  }

  const phases: PhaseFolder[] = [];
  for (const name of entries) {
    const dir = join(phasesDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const match = PHASE_FOLDER_RE.exec(name);
    if (!match) {
      phases.push({
        folderName: name,
        dir,
        order: undefined,
        slug: undefined,
        malformed: true,
      });
      continue;
    }
    const order = Number.parseInt(match[1]!, 10);
    const slug = match[2]!;
    phases.push({
      folderName: name,
      dir,
      order,
      slug,
      malformed: false,
    });
  }

  phases.sort((a, b) => {
    if (a.malformed && !b.malformed) return 1;
    if (!a.malformed && b.malformed) return -1;
    if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
    return a.folderName.localeCompare(b.folderName);
  });

  return phases;
}

/**
 * Validate phase folder structure for a single session. Returns issues for:
 * - malformed folder names (not matching `NN-<slug>`)
 * - non-kebab-case slugs
 * - slugs longer than the max length
 * - duplicate `NN` prefixes
 * - gaps in the `NN` sequence (must be 1..N)
 * - sequence not starting at 1
 * - missing `spec.mdx` in a phase folder (error)
 * - missing `orchestrator.md` in a phase folder (warning)
 */
export function validatePhaseStructure(sessionDir: string): ValidationIssue[] {
  const phases = listPhases(sessionDir);
  if (phases.length === 0) return [];

  const issues: ValidationIssue[] = [];

  // Per-folder format / slug / content checks.
  for (const phase of phases) {
    if (phase.malformed) {
      issues.push({
        file: phase.dir,
        severity: 'error',
        message: `Phase folder "${phase.folderName}" does not match required format \`NN-<slug>\` (e.g. \`01-core\`)`,
      });
    } else {
      const slug = phase.slug!;
      if (slug.length > MAX_SLUG_LENGTH) {
        issues.push({
          file: phase.dir,
          severity: 'error',
          message: `Phase folder "${phase.folderName}" slug is ${slug.length} chars (max ${MAX_SLUG_LENGTH})`,
        });
      } else if (!KEBAB_CASE_RE.test(slug)) {
        issues.push({
          file: phase.dir,
          severity: 'error',
          message: `Phase folder "${phase.folderName}" slug "${slug}" must be kebab-case (lowercase letters, digits, and hyphens; no leading/trailing/consecutive hyphens)`,
        });
      }
    }

    if (!existsSync(join(phase.dir, 'spec.mdx'))) {
      issues.push({
        file: phase.dir,
        severity: 'error',
        message: `Phase folder "${phase.folderName}" is missing required file \`spec.mdx\``,
      });
    }
    const specPath = join(phase.dir, 'spec.mdx');
    if (existsSync(specPath) && !hasFrontmatterTitle(specPath)) {
      issues.push({
        file: specPath,
        severity: 'warning',
        message: `Phase folder "${phase.folderName}" spec.mdx is missing a \`title\` (needed for the live timeline label)`,
      });
    }
    if (!existsSync(join(phase.dir, 'orchestrator.md'))) {
      issues.push({
        file: phase.dir,
        severity: 'warning',
        message: `Phase folder "${phase.folderName}" has no \`orchestrator.md\` (recommended for multi-step phases)`,
      });
    }
  }

  // Sequence checks — duplicates, gaps, must start at 1. Skip malformed
  // folders (already reported); we work off well-formed numeric prefixes.
  const orders = phases
    .filter((p): p is PhaseFolder & { order: number } => !p.malformed && p.order !== undefined)
    .map((p) => p.order)
    .sort((a, b) => a - b);

  if (orders.length > 0) {
    const counts = new Map<number, number>();
    for (const o of orders) counts.set(o, (counts.get(o) ?? 0) + 1);
    const duplicates = [...counts.entries()]
      .filter(([, c]) => c > 1)
      .map(([n]) => n)
      .sort((a, b) => a - b);
    for (const n of duplicates) {
      issues.push({
        file: join(sessionDir, 'phases'),
        severity: 'error',
        message: `Duplicate phase number ${String(n).padStart(2, '0')} — each \`NN\` prefix must be unique`,
      });
    }

    const unique = [...counts.keys()].sort((a, b) => a - b);
    if (unique[0] !== 1) {
      issues.push({
        file: join(sessionDir, 'phases'),
        severity: 'error',
        message: `Phase numbering must start at 01 (lowest found: ${String(unique[0]).padStart(2, '0')})`,
      });
    }
    // Gap detection — sequence must be 1..N with no missing values.
    const max = unique[unique.length - 1]!;
    for (let expected = 1; expected <= max; expected++) {
      if (!counts.has(expected)) {
        issues.push({
          file: join(sessionDir, 'phases'),
          severity: 'error',
          message: `Gap in phase sequence: missing phase ${String(expected).padStart(2, '0')} (sequence must be 1..N with no gaps)`,
        });
      }
    }
  }

  return issues;
}

/**
 * Context required to resolve a CrossRef target. The validator owns the
 * concrete data; this module only needs the lookup shape.
 */
export interface PhaseRefContext {
  /** Map: phase slug -> parsed `spec.mdx` (heading slugs, etc.). */
  phases: Map<string, ParsedSpec>;
}

export type CrossRefResult = { ok: true } | { ok: false; reason: string };

/**
 * Resolve a CrossRef `to=` string in the form `phases/<slug>[#<anchor>]`
 * against the session's phase folders. The slug — not the numeric prefix —
 * is the identifier, so refs survive renumbering.
 */
export function resolvePhaseCrossRef(target: string, ctx: PhaseRefContext): CrossRefResult {
  const [head, anchor] = target.split('#');
  if (!head) return { ok: false, reason: 'CrossRef `to` is empty' };
  const phasePrefix = 'phases/';
  if (!head.startsWith(phasePrefix)) {
    return { ok: false, reason: `Not a phases/ CrossRef target: "${target}"` };
  }
  const slug = head.slice(phasePrefix.length);
  if (!slug) {
    return { ok: false, reason: `CrossRef "${target}" is missing a phase slug` };
  }
  const spec = ctx.phases.get(slug);
  if (!spec) {
    const known = [...ctx.phases.keys()];
    const hint = known.length > 0 ? ` (known phases: ${known.join(', ')})` : '';
    return { ok: false, reason: `Unknown phase slug "${slug}"${hint}` };
  }
  if (anchor && !spec.headingSlugs.has(anchor)) {
    return { ok: false, reason: `Unknown anchor "${anchor}" in phase "${slug}"` };
  }
  return { ok: true };
}
