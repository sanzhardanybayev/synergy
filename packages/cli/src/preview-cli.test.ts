import cac from 'cac';
import { describe, expect, it, vi } from 'vitest';
import { type PreviewCliDependencies, registerPreviewCommand } from './preview-cli.js';
import type { PreviewStatus } from './preview.js';

interface CliResult {
  exitCode: number | undefined;
  stderr: string;
  stdout: string;
}

async function runPreviewCli(
  args: string[],
  dependencies: PreviewCliDependencies = {},
): Promise<CliResult> {
  const cli = cac('synergy');
  registerPreviewCommand(cli, dependencies);
  const stderr: string[] = [];
  const stdout: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    cli.parse(['node', 'synergy', 'preview', ...args], { run: false });
    await cli.runMatchedCommand();
    return { exitCode: process.exitCode, stderr: stderr.join(''), stdout: stdout.join('') };
  } finally {
    process.exitCode = previousExitCode;
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  }
}

const RUNNING_STATUS: PreviewStatus = {
  running: true,
  pid: 12_345,
  port: 4_321,
  origin: 'http://127.0.0.1:4321',
  projectId: 'project-1',
  instanceId: 'instance-1',
  timings: {
    lockMs: 1,
    launchMs: 2,
    listenMs: 3,
    healthMs: 4,
    totalMs: 10,
  },
};

describe('preview CLI', () => {
  it('returns a nonzero exit status when stop cannot verify shutdown', async () => {
    const result = await runPreviewCli(['stop'], {
      previewStop: vi.fn().mockResolvedValue(false),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Error:.*could not be confirmed/i);
  });

  it('emits only the complete start result as JSON', async () => {
    const previewStart = vi.fn().mockResolvedValue(RUNNING_STATUS);

    const result = await runPreviewCli(['start', '--root', '/project', '--json'], {
      previewStart,
    });

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(RUNNING_STATUS);
    expect(previewStart).toHaveBeenCalledWith({ root: '/project', quiet: true });
  });

  it('emits a stable stop confirmation as JSON', async () => {
    const previewStop = vi.fn().mockResolvedValue(true);

    const result = await runPreviewCli(['stop', '--root', '/project', '--json'], {
      previewStop,
    });

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ stopped: true });
    expect(previewStop).toHaveBeenCalledWith('/project', { quiet: true });
  });

  it.each([
    ['start', { previewStart: vi.fn().mockRejectedValue(new Error('start failed')) }],
    ['stop', { previewStop: vi.fn().mockResolvedValue(false) }],
  ] as const)(
    'keeps failed JSON %s commands nonzero and JSON-free',
    async (action, dependencies) => {
      const result = await runPreviewCli([action, '--json'], dependencies);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/Error:/u);
    },
  );

  it('preserves human start and stop invocation behavior without JSON', async () => {
    const previewStart = vi.fn().mockResolvedValue(RUNNING_STATUS);
    const previewStop = vi.fn().mockResolvedValue(true);

    const start = await runPreviewCli(['start', '--root', '/project'], { previewStart });
    const stop = await runPreviewCli(['stop', '--root', '/project'], { previewStop });

    expect(start).toEqual({ exitCode: undefined, stderr: '', stdout: '' });
    expect(stop).toEqual({ exitCode: undefined, stderr: '', stdout: '' });
    expect(previewStart).toHaveBeenCalledWith({ root: '/project' });
    expect(previewStop).toHaveBeenCalledWith('/project');
  });

  it('emits the complete status result as JSON', async () => {
    const result = await runPreviewCli(['status', '--json'], {
      previewStatus: vi.fn().mockResolvedValue(RUNNING_STATUS),
    });

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(RUNNING_STATUS);
  });
});
