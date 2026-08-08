import type { ReviewBundle, ReviewSnapshot } from '@synergy/review-core';
import { type DriftState, fileDriftOnDisk } from '../data/drift.js';
import type { SerializedBundle } from './messages.js';

/** Every path this snapshot knows about: captured files plus any item path not otherwise captured. */
function snapshotPaths(snapshot: ReviewSnapshot): string[] {
  const paths = new Set<string>();
  for (const file of snapshot.files) paths.add(file.path);
  for (const item of snapshot.items) paths.add(item.path);
  return [...paths];
}

/**
 * Builds the wire-shape the webview consumes for the review screen: the bundle itself plus a
 * per-file drift map computed against the current working tree. Pure aside from the filesystem
 * reads inside `fileDriftOnDisk`, so it is exercised directly in tests without a `vscode` host.
 */
export function serializeBundle(projectRoot: string, bundle: ReviewBundle): SerializedBundle {
  const drift: Record<string, DriftState> = {};
  for (const path of snapshotPaths(bundle.snapshot)) {
    drift[path] = fileDriftOnDisk(projectRoot, bundle.snapshot, path);
  }
  return { bundle, drift, projectRoot };
}
