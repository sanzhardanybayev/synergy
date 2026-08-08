import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
import { MANIFEST_FILE, seedFixtureRepo } from './fixtures.mjs';

/**
 * Driver for the extension-host integration suite. Runs in plain Node (not inside VS Code):
 * seeds a throwaway fixture repository, downloads a pinned VS Code build, and launches it with
 * this package as a development extension and `out-test/suite/index.js` as the test entry point.
 *
 * The fixture repo is passed as the workspace folder so the extension's real activation event
 * (`onView:synergyReview.panel`) and its real `.synergy/reviews` watcher see a genuine workspace.
 */

const here = dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = resolve(here, '..', '..');

/** Pinned so a VS Code stable release never silently changes what the suite runs against. */
const VSCODE_VERSION = '1.96.0';

async function main(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'synergy-vscode-it-'));
  const keepFixture = process.argv.includes('--keep-fixture');
  try {
    const manifest = seedFixtureRepo(fixtureRoot);
    console.log(`fixture repo: ${manifest.root}`);

    await runTests({
      version: VSCODE_VERSION,
      extensionDevelopmentPath,
      extensionTestsPath: resolve(extensionDevelopmentPath, 'out-test', 'suite', 'index.js'),
      extensionTestsEnv: {
        SYNERGY_FIXTURE_MANIFEST: join(fixtureRoot, MANIFEST_FILE),
      },
      launchArgs: [
        fixtureRoot,
        // Isolate from the developer's real profile without `--disable-extensions`: that flag
        // also switches off the BUILT-IN extensions, and one of the assertions depends on
        // typescript-language-features actually answering a document-symbol request.
        '--user-data-dir',
        join(fixtureRoot, '.vscode-user-data'),
        '--extensions-dir',
        join(fixtureRoot, '.vscode-extensions'),
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
    });
  } finally {
    if (keepFixture) console.log(`kept fixture repo: ${fixtureRoot}`);
    else rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
