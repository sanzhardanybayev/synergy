import { sep } from 'node:path';
import { resolve } from 'node:path';

/**
 * Resolve a path that is relative to `sessionsDir`, asserting the result
 * remains strictly inside `sessionsDir`. Throws a descriptive Error on any
 * path traversal attempt (e.g. `../../etc/passwd`).
 *
 * Callers pass the raw `file` field from the request body — the value is
 * never interpolated into a shell command.
 *
 * @param sessionsDir  - Absolute path to the sessions directory.
 * @param relativeFile - Path relative to sessionsDir (e.g. "2026-05-25-foo/spec.mdx").
 * @returns The resolved absolute path.
 */
export function resolveSessionsRelative(sessionsDir: string, relativeFile: string): string {
  if (typeof relativeFile !== 'string' || relativeFile.length === 0) {
    throw new Error('resolveSessionsRelative: relativeFile must be a non-empty string');
  }

  const resolved = resolve(sessionsDir, relativeFile);

  // Ensure the resolved path is strictly inside sessionsDir.
  // We normalize sessionsDir to include the trailing separator so that a
  // directory named e.g. ".synergy/sessions-evil" cannot match.
  const base = sessionsDir.endsWith(sep) ? sessionsDir : sessionsDir + sep;

  if (!resolved.startsWith(base)) {
    throw new Error(
      `Path traversal rejected: "${relativeFile}" resolves to "${resolved}" which is outside "${sessionsDir}"`,
    );
  }

  return resolved;
}

/**
 * Resolve a path that is relative to a specific session directory (inside
 * sessionsDir). Used by `/api/feedback` which takes a separate `session` and
 * `file` parameter rather than a combined relative path.
 *
 * @param sessionsDir - Absolute path to the sessions directory.
 * @param session     - Session name (e.g. "2026-05-25-foo").
 * @param fileRel     - Path relative to the session dir (e.g. "phases/02-impl/spec.mdx").
 * @returns The resolved absolute path.
 */
export function resolveSessionFile(sessionsDir: string, session: string, fileRel: string): string {
  if (typeof session !== 'string' || session.length === 0) {
    throw new Error('resolveSessionFile: session must be a non-empty string');
  }
  // Delegate to the same traversal check — combine session + fileRel as a
  // single relative path from sessionsDir.
  const combined = `${session}/${fileRel}`;
  return resolveSessionsRelative(sessionsDir, combined);
}
