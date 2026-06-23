import { statSync } from 'node:fs';
import { type ParsedSpec, parseSpec } from './parse.js';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  spec: ParsedSpec;
}

const cache = new Map<string, CacheEntry>();

/**
 * Parse an MDX spec, reusing the previous result when the file is unchanged.
 *
 * Keyed by absolute path + `mtimeMs` + byte `size`. The size acts as a cheap
 * second signal so a same-millisecond rewrite of a different length is not
 * served stale. In a one-shot CLI process the cache is always cold (no
 * behavioral change); in the long-lived preview daemon repeated validations
 * only re-parse the files that actually changed.
 */
export function parseSpecCached(filePath: string): ParsedSpec {
  const stat = statSync(filePath);
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.spec;
  const spec = parseSpec(filePath);
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, spec });
  return spec;
}

/** Empty the parse cache. */
export function clearParseCache(): void {
  cache.clear();
}
