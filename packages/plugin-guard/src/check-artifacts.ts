import { assertRuntimeArtifacts } from './artifacts.js';

try {
  assertRuntimeArtifacts(process.cwd());
  process.stdout.write('Runtime artifacts: OK\n');
} catch (error) {
  const message = error instanceof Error ? error.message : 'Runtime artifact inspection failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
