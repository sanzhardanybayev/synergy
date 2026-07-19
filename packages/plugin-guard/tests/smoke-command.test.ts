import { describe, expect, it } from 'vitest';
import { runDefaultSmokeCommand } from '../src/smoke-plugin-archive.js';

describe('default archive smoke command diagnostics', () => {
  it('reports bounded stdout and stderr when a command fails', () => {
    const script = [
      "process.stdout.write(`stdout-marker:${'x'.repeat(20_000)}:stdout-tail`);",
      "process.stderr.write(`stderr-marker:${'y'.repeat(20_000)}:stderr-tail`);",
      'process.exit(23);',
    ].join('');

    let failure: Error | null = null;
    try {
      runDefaultSmokeCommand({
        command: process.execPath,
        args: ['-e', script],
        cwd: process.cwd(),
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    expect(failure).not.toBeNull();
    expect(failure?.message).toContain('Archive smoke command failed (exit 23)');
    expect(failure?.message).toContain('stdout-marker:');
    expect(failure?.message).toContain('stderr-marker:');
    expect(failure?.message).toContain('[truncated]');
    expect(failure?.message).toMatch(/stdout:\nstdout-marker:[\s\S]*:stdout-tail\nstderr:/u);
    expect(failure?.message).toMatch(/stderr:\nstderr-marker:[\s\S]*:stderr-tail$/u);
    expect(failure?.message.length).toBeLessThan(12_000);
  });
});
