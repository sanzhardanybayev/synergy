import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { componentNames, schemas, type ComponentName } from '@synergy/spec-kit';
import Ajv, { type ValidateFunction } from 'ajv';
import { parseSpec, type ParsedSpec } from './parse.js';
import type {
  SessionInventory,
  ValidateOptions,
  ValidationIssue,
  ValidationReport,
} from './types.js';

const ajv = new Ajv({ allErrors: true, strict: false });

const validators: Map<ComponentName, ValidateFunction> = new Map();
for (const name of componentNames) {
  validators.set(name, ajv.compile(schemas[name] as object));
}

/** Headings the spec layout requires inside `00-overview.mdx`. */
const REQUIRED_OVERVIEW_HEADINGS = ['summary', 'goals'] as const;

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

/**
 * Check that `00-overview.mdx` contains the required structural headings
 * (`## Summary` and `## Goals`). No-op when the overview file is absent.
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

function resolveCrossRef(
  target: string,
  inventory: SessionInventory,
): { ok: true } | { ok: false; reason: string } {
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

function validateSession(sessionDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const files = listMdxFiles(sessionDir);
  if (files.length === 0) {
    issues.push({
      file: sessionDir,
      severity: 'warning',
      message: 'Session contains no .mdx files',
    });
    return issues;
  }

  const parsed: ReturnType<typeof parseSpec>[] = [];
  for (const f of files) {
    try {
      parsed.push(parseSpec(f));
    } catch (err) {
      const e = err as { line?: number; column?: number; reason?: string; message?: string };
      issues.push({
        file: f,
        line: e.line,
        column: e.column,
        severity: 'error',
        message: `Parse failed: ${e.reason ?? e.message ?? String(err)}`,
      });
    }
  }
  const inventory = buildInventory(parsed);

  // Required-heading check on the overview file.
  issues.push(...validateOverviewHeadings(parsed));

  for (const spec of parsed) {
    for (const comp of spec.components) {
      if (!isComponent(comp.name)) continue; // unknown / session-local component
      // Warn on unparseable attributes — we can't validate them.
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
      const validate = validators.get(comp.name)!;
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
      // CrossRef target resolution.
      if (comp.name === 'CrossRef') {
        const to = comp.attributes.to;
        if (typeof to === 'string') {
          const result = resolveCrossRef(to, inventory);
          if (!result.ok) {
            issues.push({
              file: spec.filePath,
              line: comp.line,
              column: comp.column,
              component: 'CrossRef',
              severity: 'error',
              message: `CrossRef to="${to}" — ${result.reason}`,
            });
          }
        }
      }
    }
  }

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
    filesChecked += listMdxFiles(sessionDir).length;
    allIssues.push(...validateSession(sessionDir));
  }
  return { issues: allIssues, filesChecked, sessionsChecked };
}
