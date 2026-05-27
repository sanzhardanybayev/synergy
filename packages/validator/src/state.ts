import { existsSync, readFileSync } from 'node:fs';
import { type ProgressFile, progressJsonSchema, progressPath } from '@synergy/state';
import Ajv from 'ajv';
import type { ValidationIssue } from './types.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const validateProgress = ajv.compile(progressJsonSchema as object);

/**
 * Validate a session's `.state/progress.json` (if present): JSON parse, schema
 * shape, and that each phase slug is a known phase id (folder slug or inline
 * `<Phase id>`). No-op when the file is absent.
 */
export function validateStateForSession(
  sessionDir: string,
  knownPhaseIds: Set<string>,
): ValidationIssue[] {
  const file = progressPath(sessionDir);
  if (!existsSync(file)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return [
      {
        file,
        severity: 'error',
        message: `progress.json is not valid JSON: ${(err as Error).message}`,
      },
    ];
  }

  const issues: ValidationIssue[] = [];
  if (!validateProgress(parsed)) {
    for (const e of validateProgress.errors ?? []) {
      issues.push({
        file,
        severity: 'error',
        message: `progress.json ${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
      });
    }
    return issues;
  }

  const progress = parsed as ProgressFile;
  for (const phase of progress.phases) {
    if (!knownPhaseIds.has(phase.slug)) {
      const known = [...knownPhaseIds];
      const hint = known.length ? ` (known: ${known.join(', ')})` : '';
      issues.push({
        file,
        severity: 'error',
        message: `progress.json references unknown phase slug "${phase.slug}"${hint}`,
      });
    }
  }
  return issues;
}
