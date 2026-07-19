import { lstatSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { ReviewCoreError } from './errors.js';
import { assertSafeReviewSegment } from './ids.js';

function fileSystemErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

export function canonicalProjectRoot(projectRoot: string): string {
  try {
    return realpathSync.native(resolve(projectRoot));
  } catch {
    throw new ReviewCoreError('review_internal', 'unable to resolve review project root');
  }
}

/**
 * Rejects symbolic links in every existing component below the canonical project root.
 *
 * Missing suffixes are allowed so callers can safely create new artifact directories. This is
 * the strongest practical synchronous Node boundary check; callers still revalidate immediately
 * before publication because filesystem path checks cannot eliminate every TOCTOU race.
 */
export function assertReviewArtifactPath(projectRoot: string, artifactPath: string): string {
  const root = canonicalProjectRoot(projectRoot);
  const target = resolve(artifactPath);
  const suffix = relative(root, target);
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || resolve(root, suffix) !== target) {
    throw new ReviewCoreError('review_corrupt', 'review artifact path escapes project root');
  }

  let current = root;
  for (const segment of suffix.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new ReviewCoreError(
          'review_corrupt',
          'review artifact path contains a symbolic link',
        );
      }
    } catch (error) {
      if (error instanceof ReviewCoreError) throw error;
      if (fileSystemErrorCode(error) === 'ENOENT') break;
      throw new ReviewCoreError('review_internal', 'unable to validate review artifact path');
    }
  }
  return target;
}

export function reviewsDir(projectRoot: string): string {
  return assertReviewArtifactPath(
    projectRoot,
    resolve(canonicalProjectRoot(projectRoot), '.synergy', 'reviews'),
  );
}

export function reviewWorkspaceDir(projectRoot: string, workspaceId: string): string {
  assertSafeReviewSegment(workspaceId, 'workspace');
  return assertReviewArtifactPath(
    projectRoot,
    resolveReviewPath(reviewsDir(projectRoot), workspaceId),
  );
}

export function reviewRevisionDir(
  projectRoot: string,
  workspaceId: string,
  revisionId: string,
): string {
  assertSafeReviewSegment(revisionId, 'revision');
  return assertReviewArtifactPath(
    projectRoot,
    resolveReviewPath(reviewWorkspaceDir(projectRoot, workspaceId), 'revisions', revisionId),
  );
}

export function resolveReviewPath(baseDir: string, ...segments: string[]): string {
  const resolved = resolve(baseDir, ...segments);
  const base = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;
  if (!resolved.startsWith(base)) {
    throw new Error('review artifact path escapes reviews directory');
  }
  return resolved;
}

export function workspaceFile(projectRoot: string, workspaceId: string): string {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewWorkspaceDir(projectRoot, workspaceId), 'workspace.json'),
  );
}

export function snapshotFile(projectRoot: string, workspaceId: string, revisionId: string): string {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewRevisionDir(projectRoot, workspaceId, revisionId), 'snapshot.json'),
  );
}

export function insightsFile(projectRoot: string, workspaceId: string, revisionId: string): string {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewRevisionDir(projectRoot, workspaceId, revisionId), 'insights.json'),
  );
}

export function progressFile(projectRoot: string, workspaceId: string, revisionId: string): string {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewRevisionDir(projectRoot, workspaceId, revisionId), 'progress.json'),
  );
}

export function questionsDir(projectRoot: string, workspaceId: string, revisionId: string): string {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewRevisionDir(projectRoot, workspaceId, revisionId), 'questions'),
  );
}

export function answersDir(projectRoot: string, workspaceId: string, revisionId: string): string {
  return assertReviewArtifactPath(
    projectRoot,
    join(reviewRevisionDir(projectRoot, workspaceId, revisionId), 'answers'),
  );
}
