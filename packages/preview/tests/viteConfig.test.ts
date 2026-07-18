/**
 * The dev-server fs.allow list must cover the self-hosted @fontsource woff2
 * assets even when the project root points outside this workspace (the normal
 * case: a consumer project). Regression test for fonts 403ing and silently
 * falling back to system typefaces.
 */

import { createRequire } from 'node:module';
import { dirname, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONT_PACKAGES, buildFsAllowList } from '../vite-fs-allow.js';

const require = createRequire(import.meta.url);

describe('buildFsAllowList', () => {
  it('covers every self-hosted font package dir when the project root is external', () => {
    const allow = buildFsAllowList(
      '/app/packages/preview',
      '/tmp/some-consumer-project',
      '/tmp/some-consumer-project/.synergy/sessions',
    );

    for (const pkg of FONT_PACKAGES) {
      const pkgDir = dirname(require.resolve(`${pkg}/package.json`));
      const covered = allow.some((dir) => pkgDir === dir || pkgDir.startsWith(dir + sep));
      expect(covered, `${pkg} dir ${pkgDir} not covered by fs.allow: ${allow.join(', ')}`).toBe(
        true,
      );
    }
  });

  it('keeps the app dir, project root, and sessions dir', () => {
    const allow = buildFsAllowList('/a', '/b', '/c');
    expect(allow.slice(0, 3)).toEqual(['/a', '/b', '/c']);
  });
});
