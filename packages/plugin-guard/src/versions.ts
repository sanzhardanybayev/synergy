/** Compare two dotted numeric versions. Returns -1, 0, or 1. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** Highest version in the list, or null when empty. */
export function newest(versions: string[]): string | null {
  if (versions.length === 0) return null;
  return versions.reduce((hi, v) => (compareVersions(v, hi) > 0 ? v : hi));
}

/** True when a strictly newer version than `mine` is installed. */
export function isStale(mine: string, installed: string[]): boolean {
  const hi = newest(installed);
  return hi !== null && compareVersions(mine, hi) < 0;
}
