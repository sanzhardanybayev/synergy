import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type ComponentName, componentNames, schemas } from '@synergy/spec-kit';
import Ajv, { type ValidateFunction } from 'ajv';
import { parseSpecCached } from './cache.js';
import type { ParsedSpec } from './parse.js';
import { listPhases, resolvePhaseCrossRef, validatePhaseStructure } from './phase.js';
import { validateStateForSession } from './state.js';
import type {
  SessionInventory,
  ValidateOptions,
  ValidationIssue,
  ValidationReport,
} from './types.js';

let validatorsCache: Map<ComponentName, ValidateFunction> | null = null;

/**
 * Compile component schemas on first use, not at module load. Importing this module
 * (e.g. for {@link parseSpec}) no longer pays the Ajv compilation cost, so CLI commands
 * that don't validate stay cheap.
 */
function getValidators(): Map<ComponentName, ValidateFunction> {
  if (validatorsCache) return validatorsCache;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const map: Map<ComponentName, ValidateFunction> = new Map();
  for (const name of componentNames) {
    map.set(name, ajv.compile(schemas[name] as object));
  }
  validatorsCache = map;
  return map;
}

const REQUIRED_OVERVIEW_HEADINGS = ['summary', 'goals'] as const;
const PHASE_REF_PREFIX = 'phases/';
/** Heuristic: legacy phase ref like "02-implementation#phase-1". */
const LEGACY_PHASE_REF_RE = /^[0-9]{2}-implementation#phase-[0-9]+$/;

function isComponent(name: string): name is ComponentName {
  return (componentNames as string[]).includes(name);
}

function listSessions(projectRoot: string): string[] {
  const sessionsDir = resolve(projectRoot, '.synergy', 'sessions');
  try {
    return readdirSync(sessionsDir)
      .filter((name) => {
        try {
          return statSync(join(sessionsDir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function listMdxFiles(sessionDir: string): string[] {
  try {
    return readdirSync(sessionDir)
      .filter((f) => /\.mdx$/i.test(f))
      .sort()
      .map((f) => join(sessionDir, f));
  } catch {
    return [];
  }
}

function buildInventory(parsed: ParsedSpec[]): SessionInventory {
  const headings: Record<string, Set<string>> = {};
  const files: string[] = [];
  for (const spec of parsed) {
    headings[spec.slug] = spec.headingSlugs;
    files.push(spec.slug);
  }
  return { headings, files };
}

interface ResolveContext {
  inventory: SessionInventory;
  phases: Map<string, ParsedSpec>;
}

interface ResolveOutcome {
  ok: boolean;
  /** Reason for an `ok: false` result. */
  reason?: string;
  /** Optional warning to emit even when the ref resolves. */
  warning?: string;
}

function resolveLegacyFileRef(target: string, inventory: SessionInventory): ResolveOutcome {
  const [slug, anchor] = target.split('#');
  if (!slug) return { ok: false, reason: 'CrossRef `to` is empty' };
  if (!(slug in inventory.headings)) {
    return { ok: false, reason: `Unknown spec slug "${slug}"` };
  }
  if (anchor && !inventory.headings[slug]!.has(anchor)) {
    return { ok: false, reason: `Unknown anchor "${anchor}" in spec "${slug}"` };
  }
  return { ok: true };
}

/**
 * Route a CrossRef `to=` target through the appropriate resolver:
 * - `phases/<slug>[#<anchor>]` -> new phase-folder resolver.
 * - everything else -> legacy file-anchor resolver.
 * - if the legacy form happens to look like the deprecated phase ref
 *   (`<NN>-implementation#phase-<N>`) and resolves, emit a warning that
 *   points authors toward the new form.
 */
function resolveCrossRef(target: string, ctx: ResolveContext): ResolveOutcome {
  if (target.startsWith(PHASE_REF_PREFIX)) {
    const result = resolvePhaseCrossRef(target, { phases: ctx.phases });
    if (result.ok) return { ok: true };
    return { ok: false, reason: result.reason };
  }

  const result = resolveLegacyFileRef(target, ctx.inventory);
  if (!result.ok) return result;

  if (LEGACY_PHASE_REF_RE.test(target)) {
    return {
      ok: true,
      warning: `Legacy phase CrossRef form \`${target}\` — prefer the new \`phases/<slug>\` form (e.g. \`phases/core\`) so refs survive renumbering.`,
    };
  }
  return { ok: true };
}

/**
 * Check that `00-overview.mdx` contains the required structural headings
 * (`## Summary` and `## Goals`). No-op when the file is absent — the
 * spec layout requires it, but enforcing presence is outside the scope
 * of this Phase 1 change.
 */
function validateOverviewHeadings(parsed: ParsedSpec[]): ValidationIssue[] {
  const overview = parsed.find((p) => p.slug === '00-overview');
  if (!overview) return [];
  const issues: ValidationIssue[] = [];
  for (const required of REQUIRED_OVERVIEW_HEADINGS) {
    if (!overview.headingSlugs.has(required)) {
      const heading = required[0]!.toUpperCase() + required.slice(1);
      issues.push({
        file: overview.filePath,
        severity: 'error',
        message: `\`00-overview.mdx\` is missing required heading \`## ${heading}\``,
      });
    }
  }
  return issues;
}

interface ParseAttempt {
  parsed?: ParsedSpec;
  issue?: ValidationIssue;
}

function tryParse(file: string): ParseAttempt {
  try {
    return { parsed: parseSpecCached(file) };
  } catch (err) {
    const e = err as { line?: number; column?: number; reason?: string; message?: string };
    return {
      issue: {
        file,
        line: e.line,
        column: e.column,
        severity: 'error',
        message: `Parse failed: ${e.reason ?? e.message ?? String(err)}`,
      },
    };
  }
}

interface PhaseParseResult {
  /** Map: phase slug -> parsed `spec.mdx`. Excludes phases with parse errors / missing files. */
  parsed: Map<string, ParsedSpec>;
  /** Issues collected while parsing phase `spec.mdx` files. */
  issues: ValidationIssue[];
}

function parsePhases(sessionDir: string): PhaseParseResult {
  const phases = listPhases(sessionDir);
  const parsed = new Map<string, ParsedSpec>();
  const issues: ValidationIssue[] = [];
  for (const phase of phases) {
    if (phase.malformed || !phase.slug) continue;
    const specFile = join(phase.dir, 'spec.mdx');
    if (!existsSync(specFile)) continue;
    const attempt = tryParse(specFile);
    if (attempt.issue) {
      issues.push(attempt.issue);
      continue;
    }
    if (attempt.parsed) parsed.set(phase.slug, attempt.parsed);
  }
  return { parsed, issues };
}

function validateSession(sessionDir: string, files = listMdxFiles(sessionDir)): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (files.length === 0) {
    issues.push({
      file: sessionDir,
      severity: 'warning',
      message: 'Session contains no .mdx files',
    });
    return issues;
  }

  const parsed: ParsedSpec[] = [];
  for (const f of files) {
    const attempt = tryParse(f);
    if (attempt.issue) issues.push(attempt.issue);
    if (attempt.parsed) parsed.push(attempt.parsed);
  }
  const inventory = buildInventory(parsed);

  // Required-heading check on the overview file.
  issues.push(...validateOverviewHeadings(parsed));

  // Phase folder structural validation.
  issues.push(...validatePhaseStructure(sessionDir));

  // Parse phase spec.mdx files so phase CrossRefs and anchors resolve.
  const phaseParse = parsePhases(sessionDir);
  issues.push(...phaseParse.issues);

  // Every parsed file — top-level + phases — feeds component / CrossRef validation.
  const allParsed: ParsedSpec[] = [...parsed, ...phaseParse.parsed.values()];
  const ctx: ResolveContext = { inventory, phases: phaseParse.parsed };

  for (const spec of allParsed) {
    for (const comp of spec.components) {
      if (!isComponent(comp.name)) continue; // unknown / session-local component
      for (const attrName of comp.unparsedAttributes) {
        issues.push({
          file: spec.filePath,
          line: comp.line,
          column: comp.column,
          component: comp.name,
          severity: 'warning',
          message: `Attribute \`${attrName}\` is a non-literal expression; cannot validate against schema`,
        });
      }
      if (comp.name === 'Phase' && comp.attributes.id === undefined) {
        issues.push({
          file: spec.filePath,
          line: comp.line,
          column: comp.column,
          component: 'Phase',
          severity: 'warning',
          message:
            'Phase has no `id` — add a stable slug (e.g. id="storage") so execution state survives renumbering.',
        });
      }
      const validate = getValidators().get(comp.name)!;
      const ok = validate(comp.attributes);
      if (!ok) {
        for (const err of validate.errors ?? []) {
          const path = err.instancePath || '(root)';
          issues.push({
            file: spec.filePath,
            line: comp.line,
            column: comp.column,
            component: comp.name,
            severity: 'error',
            message: `${path} ${err.message ?? 'invalid'}`,
          });
        }
      }
      if (comp.name === 'CrossRef') {
        const to = comp.attributes.to;
        if (typeof to === 'string') {
          const result = resolveCrossRef(to, ctx);
          if (!result.ok) {
            issues.push({
              file: spec.filePath,
              line: comp.line,
              column: comp.column,
              component: 'CrossRef',
              severity: 'error',
              message: `CrossRef to="${to}" — ${result.reason}`,
            });
          } else if (result.warning) {
            issues.push({
              file: spec.filePath,
              line: comp.line,
              column: comp.column,
              component: 'CrossRef',
              severity: 'warning',
              message: result.warning,
            });
          }
        }
      }
    }
  }

  // Collect known phase ids: folder slugs + inline <Phase id="..."> values.
  const knownPhaseIds = new Set<string>(phaseParse.parsed.keys());
  for (const spec of allParsed) {
    for (const comp of spec.components) {
      if (comp.name === 'Phase' && typeof comp.attributes.id === 'string') {
        knownPhaseIds.add(comp.attributes.id);
      }
    }
  }
  issues.push(...validateStateForSession(sessionDir, knownPhaseIds));

  return issues;
}

export function validate(options: ValidateOptions): ValidationReport {
  const root = resolve(options.projectRoot);
  const sessions = options.session ? [options.session] : listSessions(root);
  const allIssues: ValidationIssue[] = [];
  let filesChecked = 0;
  let sessionsChecked = 0;
  for (const name of sessions) {
    const sessionDir = join(root, '.synergy', 'sessions', name);
    try {
      const stat = statSync(sessionDir);
      if (!stat.isDirectory()) continue;
    } catch {
      allIssues.push({
        file: sessionDir,
        severity: 'error',
        message: `Session "${name}" not found`,
      });
      continue;
    }
    sessionsChecked++;
    const files = listMdxFiles(sessionDir);
    filesChecked += files.length;
    allIssues.push(...validateSession(sessionDir, files));
  }
  return { issues: allIssues, filesChecked, sessionsChecked };
}
