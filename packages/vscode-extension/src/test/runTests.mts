import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type TestOptions,
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';
import { MANIFEST_FILE, seedFixtureRepo } from './fixtures.mjs';

/**
 * Driver for the extension-host integration suite. Runs in plain Node (not inside VS Code):
 * seeds a throwaway fixture repository, downloads a pinned VS Code build, and launches it with
 * `out-test/suite/index.js` as the test entry point.
 *
 * The fixture repo is passed as the workspace folder so the extension's real activation event
 * (`onView:synergyReview.panel`) and its real `.synergy/reviews` watcher see a genuine workspace.
 *
 * Two modes:
 *  - default: the extension loads from source via `--extensionDevelopmentPath`.
 *  - `--vsix <path>`: the extension is INSTALLED from a packaged `.vsix` into a throwaway
 *    extensions dir first, and nothing is loaded from source. This is the belt-over-braces run -
 *    it proves the artifact a user actually installs behaves the same as the dev build.
 */

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, '..', '..');

/** Pinned so a VS Code stable release never silently changes what the suite runs against. */
const VSCODE_VERSION = '1.96.0';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Installs `vsixPath` into `extensionsDir` using the downloaded VS Code's own CLI. */
function installVsix(executablePath: string, vsixPath: string, extensionsDir: string): void {
  const [cli, ...baseArgs] = resolveCliArgsFromVSCodeExecutablePath(executablePath);
  if (!cli) throw new Error('could not resolve the VS Code CLI path');
  const result = spawnSync(
    cli,
    [...baseArgs, '--extensions-dir', extensionsDir, '--install-extension', vsixPath, '--force'],
    { encoding: 'utf8', stdio: 'pipe' },
  );
  if (result.status !== 0) {
    throw new Error(`installing ${vsixPath} failed:\n${result.stdout}\n${result.stderr}`);
  }
  console.log(result.stdout.trim());
}

async function main(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'synergy-vscode-it-'));
  const keepFixture = process.argv.includes('--keep-fixture');
  const vsix = argValue('--vsix');
  try {
    const manifest = seedFixtureRepo(fixtureRoot);
    console.log(`fixture repo: ${manifest.root}`);

    const extensionsDir = join(fixtureRoot, '.vscode-extensions');
    let executablePath: string | undefined;
    if (vsix) {
      executablePath = await downloadAndUnzipVSCode(VSCODE_VERSION);
      installVsix(executablePath, resolve(vsix), extensionsDir);
      console.log(`running against the packaged extension: ${resolve(vsix)}`);
    }

    const options: TestOptions = {
      ...(executablePath ? { vscodeExecutablePath: executablePath } : { version: VSCODE_VERSION }),
      extensionDevelopmentPath: extensionRoot,
      extensionTestsPath: resolve(extensionRoot, 'out-test', 'suite', 'index.js'),
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
        extensionsDir,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
    };
    if (vsix) {
      // In vsix mode nothing may load from source - the extension under test is the one the CLI
      // just installed into `extensionsDir`. `TestOptions` types this key as required, so the
      // "no development extension" case has to be expressed by removing it.
      Reflect.deleteProperty(options, 'extensionDevelopmentPath');
    }

    await runTests(options);
  } finally {
    if (keepFixture) console.log(`kept fixture repo: ${fixtureRoot}`);
    else rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
