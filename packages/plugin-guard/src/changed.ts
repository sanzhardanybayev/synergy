/** Directories whose change requires a plugin version bump. */
export const BEHAVIOR_DIRS = ['skills/', 'packages/', 'commands/', 'hooks/'] as const;

/** True when any changed path lives under a behavior dir. */
export function requiresBump(changedPaths: string[]): boolean {
  return changedPaths.some((p) => BEHAVIOR_DIRS.some((d) => p.startsWith(d)));
}
