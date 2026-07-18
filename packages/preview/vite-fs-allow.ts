/**
 * Compute the dev-server `server.fs.allow` list.
 *
 * Kept separate from vite.config.ts so it can be unit-tested without importing
 * vite itself. Beyond the app dir, project root, and sessions dir, it must
 * include every self-hosted @fontsource package dir: their woff2 files are
 * served as raw /@fs assets, and when SYNERGY_PROJECT_ROOT points outside this
 * workspace (a consumer project - the normal case) nothing else on the list
 * covers them, so fonts would 403 and silently fall back to system typefaces.
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

export const FONT_PACKAGES = [
  '@fontsource-variable/inter',
  '@fontsource-variable/space-grotesk',
  '@fontsource-variable/jetbrains-mono',
] as const;

export function buildFsAllowList(appDir: string, projectRoot: string, sessionsDir: string) {
  const fontDirs = FONT_PACKAGES.map((pkg) => dirname(require.resolve(`${pkg}/package.json`)));
  return [appDir, projectRoot, sessionsDir, ...fontDirs];
}
