import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEFTHOOK_ENTRYPOINT = fileURLToPath(
  new URL('../node_modules/lefthook/bin/index.js', import.meta.url),
);

function throwSpawnError(result, command) {
  if (result.error !== undefined) throw result.error;
  if (result.status === null) throw new Error(`${command} terminated without an exit code`);
}

function ownsGitMetadata(cwd) {
  try {
    const metadata = lstatSync(join(cwd, '.git'));
    return metadata.isDirectory() || metadata.isFile();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export function runLefthookInstall({
  cwd = process.cwd(),
  runProcess = spawnSync,
  writeOutput = (message) => process.stdout.write(message),
} = {}) {
  if (!ownsGitMetadata(cwd)) {
    writeOutput('Skipping lefthook install: not a Git checkout.\n');
    return 0;
  }

  const lefthookInstall = runProcess(process.execPath, [LEFTHOOK_ENTRYPOINT, 'install'], {
    cwd,
    stdio: 'inherit',
  });
  throwSpawnError(lefthookInstall, 'lefthook install');
  return lefthookInstall.status;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = runLefthookInstall();
  } catch (error) {
    process.stderr.write(
      `Failed to install lefthook: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
