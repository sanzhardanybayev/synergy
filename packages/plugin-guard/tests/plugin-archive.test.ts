import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { REQUIRED_RUNTIME_ARTIFACTS } from '../src/artifacts.js';
import {
  type SmokeCommand,
  type SmokeCommandRunner,
  runPluginArchiveSmoke,
} from '../src/smoke-plugin-archive.js';

const temporaryRoots: string[] = [];
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const EXTRA_RUNTIME_ARTIFACT = 'packages/cli/dist/runtime-chunk.js';
const RUNTIME_ORIGIN = 'http://127.0.0.1:4567';
const RUNTIME = {
  schemaVersion: 1,
  protocolVersion: 1,
  state: 'ready',
  instanceId: 'instance-1',
  projectId: 'sha256:project-1',
  pid: 43210,
  host: '127.0.0.1',
  port: 4567,
  origin: RUNTIME_ORIGIN,
  preferredPort: 4321,
  strictPort: false,
  startedAt: '2026-07-20T00:00:00.000Z',
  controlToken: 'a'.repeat(64),
  toolVersion: '0.12.1',
} as const;
const RUNNING_STATUS = {
  running: true,
  pid: RUNTIME.pid,
  port: RUNTIME.port,
  origin: RUNTIME.origin,
  projectId: RUNTIME.projectId,
  instanceId: RUNTIME.instanceId,
} as const;
const STOPPED_STATUS = {
  running: false,
  pid: null,
  port: null,
  origin: null,
  projectId: RUNTIME.projectId,
  instanceId: null,
} as const;
const HEALTH = {
  protocolVersion: RUNTIME.protocolVersion,
  state: RUNTIME.state,
  instanceId: RUNTIME.instanceId,
  projectId: RUNTIME.projectId,
  pid: RUNTIME.pid,
  port: RUNTIME.port,
} as const;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'synergy-plugin-archive-test-'));
  temporaryRoots.push(root);
  return root;
}

function writeArchive(archiveRoot: string, omittedArtifact?: string): void {
  mkdirSync(archiveRoot, { recursive: true });
  for (const artifact of [...REQUIRED_RUNTIME_ARTIFACTS, EXTRA_RUNTIME_ARTIFACT]) {
    if (artifact === omittedArtifact) continue;
    const destination = join(archiveRoot, artifact);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, `archive artifact: ${artifact}\n`, 'utf8');
  }
}

function commandLabel(invocation: SmokeCommand): string {
  return [invocation.command, ...invocation.args].join(' ');
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && path.endsWith('.md') ? [path] : [];
  });
}

interface RunnerFixtureOptions {
  malformedRunningStatus?: boolean;
  mutateOnStartFailure?: boolean;
  mutateOnStop?: boolean;
  omittedArtifact?: string;
  reviewOutput?: string;
  runningInstanceId?: string;
  startThrowsAfterPublish?: boolean;
  statusStillRunning?: boolean;
  stopThrows?: boolean;
  symlinkEscape?: boolean;
}

interface RunnerFixture {
  commands: SmokeCommand[];
  events: string[];
  runCommand: SmokeCommandRunner;
}

function makeRunnerFixture(options: RunnerFixtureOptions = {}): RunnerFixture {
  const commands: SmokeCommand[] = [];
  const events: string[] = [];
  let stopAttempted = false;

  const runCommand: SmokeCommandRunner = async (invocation) => {
    commands.push(invocation);
    const label = commandLabel(invocation);
    events.push(label);

    if (invocation.command === 'tar') {
      const destinationIndex = invocation.args.indexOf('-C') + 1;
      const archiveRoot = invocation.args[destinationIndex] ?? '';
      writeArchive(archiveRoot, options.omittedArtifact);
      if (options.symlinkEscape) {
        const outside = join(archiveRoot, '..', 'outside.js');
        const link = join(archiveRoot, 'packages/cli/dist/escape.js');
        writeFileSync(outside, 'outside archive\n', 'utf8');
        symlinkSync(outside, link);
      }
    }

    if (label.includes('review create')) {
      return { stdout: options.reviewOutput ?? '{"reference":"fixture@revision"}\n' };
    }

    if (label.includes('preview start')) {
      const rootIndex = invocation.args.indexOf('--root') + 1;
      const fixtureRoot = invocation.args[rootIndex] ?? '';
      const runtimeFile = join(fixtureRoot, '.synergy/preview.runtime.json');
      mkdirSync(join(runtimeFile, '..'), { recursive: true });
      writeFileSync(runtimeFile, `${JSON.stringify(RUNTIME)}\n`, 'utf8');
      if (options.mutateOnStartFailure) {
        writeFileSync(
          join(invocation.cwd, EXTRA_RUNTIME_ARTIFACT),
          'mutated while start failed\n',
          'utf8',
        );
      }
      if (options.startThrowsAfterPublish) throw new Error('preview start failed after publish');
      return {
        stdout: `${JSON.stringify({
          ...RUNNING_STATUS,
          instanceId: options.runningInstanceId ?? RUNNING_STATUS.instanceId,
        })}\n`,
      };
    }

    if (label.includes('preview stop')) {
      stopAttempted = true;
      if (options.mutateOnStop) {
        writeFileSync(
          join(invocation.cwd, EXTRA_RUNTIME_ARTIFACT),
          'mutated runtime chunk\n',
          'utf8',
        );
      }
      if (options.stopThrows) throw new Error('preview stop failed');
      return { stdout: '{"stopped":true}\n' };
    }

    if (label.includes('preview status')) {
      if (!stopAttempted) {
        return {
          stdout: options.malformedRunningStatus
            ? '{"running":true}\n'
            : `${JSON.stringify({
                ...RUNNING_STATUS,
                instanceId: options.runningInstanceId ?? RUNNING_STATUS.instanceId,
              })}\n`,
        };
      }
      return {
        stdout: `${JSON.stringify(options.statusStillRunning ? RUNNING_STATUS : STOPPED_STATUS)}\n`,
      };
    }

    return { stdout: '' };
  };

  return { commands, events, runCommand };
}

function healthFetch(runner: RunnerFixture, payload: unknown = HEALTH): typeof globalThis.fetch {
  return async (input) => {
    const url = String(input);
    runner.events.push(`fetch ${url}`);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function captureFailure(action: Promise<void>): Promise<Error> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected smoke to fail');
}

function findOwnedTemporaryRoot(runner: RunnerFixture): string {
  const archiveCommand = runner.commands.find(
    (command) => command.command === 'git' && command.args[0] === 'archive',
  );
  const outputIndex = archiveCommand?.args.indexOf('--output') ?? -1;
  const archiveTar = archiveCommand?.args[outputIndex + 1];
  if (archiveTar === undefined) throw new Error('Archive command did not include an output path');
  return dirname(archiveTar);
}

describe('plugin archive smoke', () => {
  it('validates the complete archive, staged review, preview identity, and proven stop', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture();

    await runPluginArchiveSmoke({
      repositoryRoot: '/repository',
      temporaryRoot,
      runCommand: runner.runCommand,
      fetch: healthFetch(runner),
    });

    const labels = runner.commands.map(commandLabel);
    expect(labels[0]).toContain('git archive --format=tar --output');
    expect(labels[0]).toMatch(/ HEAD$/u);
    expect(labels[1]).toContain('tar -xf');
    expect(labels).toContain('pnpm install --frozen-lockfile');
    expect(labels).toContain('node packages/cli/dist/cli.js --help');
    expect(labels).toContain('node packages/cli/dist/cli.js validate --root examples');
    expect(labels).toContain(
      `node packages/cli/dist/cli.js review create --staged --root ${join(temporaryRoot, 'consumer')} --json`,
    );
    expect(labels).toContain(
      `node packages/cli/dist/cli.js preview start --root ${join(temporaryRoot, 'consumer')} --json`,
    );
    expect(labels).toContain(
      `node packages/cli/dist/cli.js preview stop --root ${join(temporaryRoot, 'consumer')} --json`,
    );
    expect(
      labels.filter((label) => label.includes('preview status --root') && label.endsWith('--json')),
    ).toHaveLength(2);
    expect(labels.some((label) => /(?:^|\s)(?:build|tsup|vite)(?:\s|$)/u.test(label))).toBe(false);
    expect(runner.events).toContain(`fetch ${RUNTIME_ORIGIN}/api/runtime/health`);
    expect(runner.events.indexOf(`fetch ${RUNTIME_ORIGIN}/api/runtime/health`)).toBeLessThan(
      runner.events.findIndex((event) => event.includes('preview stop')),
    );
  });

  it('requires preview-child before installation', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture({ omittedArtifact: 'packages/cli/dist/preview-child.js' });

    await expect(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        temporaryRoot,
        runCommand: runner.runCommand,
        fetch: healthFetch(runner),
      }),
    ).rejects.toThrow('packages/cli/dist/preview-child.js');
    expect(runner.commands.map(commandLabel)).not.toContain('pnpm install --frozen-lockfile');
  });

  it('checksums non-entrypoint files across the complete runtime tree', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture({ mutateOnStop: true });

    await expect(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        temporaryRoot,
        runCommand: runner.runCommand,
        fetch: healthFetch(runner),
      }),
    ).rejects.toThrow(`Runtime artifact changed during archive smoke: ${EXTRA_RUNTIME_ARTIFACT}`);
  });

  it('attempts stop and proves stopped status when start throws after publishing', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture({ startThrowsAfterPublish: true });

    await expect(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        temporaryRoot,
        runCommand: runner.runCommand,
        fetch: healthFetch(runner),
      }),
    ).rejects.toThrow('preview start failed after publish');
    const labels = runner.commands.map(commandLabel);
    expect(labels.some((label) => label.includes('preview stop'))).toBe(true);
    expect(
      labels.some((label) => label.includes('preview status') && label.endsWith('--json')),
    ).toBe(true);
  });

  it('rejects health with the wrong runtime identity and still cleans up', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture();

    await expect(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        temporaryRoot,
        runCommand: runner.runCommand,
        fetch: healthFetch(runner, { ...HEALTH, projectId: 'sha256:wrong-project' }),
      }),
    ).rejects.toThrow('Preview health identity did not match runtime status');
    expect(runner.commands.map(commandLabel).some((label) => label.includes('preview stop'))).toBe(
      true,
    );
  });

  it('rejects malformed health and still cleans up', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture();

    await expect(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        temporaryRoot,
        runCommand: runner.runCommand,
        fetch: healthFetch(runner, { state: 'ready' }),
      }),
    ).rejects.toThrow('Preview health response was malformed');
    expect(runner.commands.map(commandLabel).some((label) => label.includes('preview stop'))).toBe(
      true,
    );
  });

  it('preserves a published fixture when stop exits nonzero', async () => {
    const runner = makeRunnerFixture({ stopThrows: true });

    const error = await captureFailure(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        runCommand: runner.runCommand,
        fetch: healthFetch(runner),
      }),
    );
    const temporaryRoot = findOwnedTemporaryRoot(runner);
    temporaryRoots.push(temporaryRoot);

    expect(error.message).toContain('preview stop failed');
    expect(error.message).toContain(`Unable to prove preview cleanup; preserved ${temporaryRoot}`);
    expect(existsSync(temporaryRoot)).toBe(true);
    expect(
      runner.commands.map(commandLabel).some((label) => label.includes('preview status')),
    ).toBe(true);
  });

  it('preserves a published fixture when post-stop status is still running', async () => {
    const runner = makeRunnerFixture({ statusStillRunning: true });

    const error = await captureFailure(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        runCommand: runner.runCommand,
        fetch: healthFetch(runner),
      }),
    );
    const temporaryRoot = findOwnedTemporaryRoot(runner);
    temporaryRoots.push(temporaryRoot);

    expect(error.message).toContain('Preview remained running after stop');
    expect(error.message).toContain(`Unable to prove preview cleanup; preserved ${temporaryRoot}`);
    expect(existsSync(temporaryRoot)).toBe(true);
  });

  it('aggregates checksum mutation with the original failing path', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture({
      startThrowsAfterPublish: true,
      mutateOnStartFailure: true,
    });

    const error = await captureFailure(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        temporaryRoot,
        runCommand: runner.runCommand,
        fetch: healthFetch(runner),
      }),
    );

    expect(error.message).toContain('preview start failed after publish');
    expect(error.message).toContain(
      `Runtime artifact changed during archive smoke: ${EXTRA_RUNTIME_ARTIFACT}`,
    );
  });

  it('rejects symlinks escaping the archive before installation', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture({ symlinkEscape: true });

    await expect(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        temporaryRoot,
        runCommand: runner.runCommand,
        fetch: healthFetch(runner),
      }),
    ).rejects.toThrow('Runtime output contains a symbolic link');
    expect(runner.commands.map(commandLabel)).not.toContain('pnpm install --frozen-lockfile');
  });

  it('requires staged review create to return a nonempty reference', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture({ reviewOutput: '{"reference":""}\n' });

    await expect(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        temporaryRoot,
        runCommand: runner.runCommand,
        fetch: healthFetch(runner),
      }),
    ).rejects.toThrow('Staged review creation did not return a reference');
    expect(runner.commands.map(commandLabel).some((label) => label.includes('preview start'))).toBe(
      false,
    );
  });

  it('rejects malformed running status and still cleans up', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture({ malformedRunningStatus: true });

    await expect(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        temporaryRoot,
        runCommand: runner.runCommand,
        fetch: healthFetch(runner),
      }),
    ).rejects.toThrow('Preview status response was malformed');
    expect(runner.commands.map(commandLabel).some((label) => label.includes('preview stop'))).toBe(
      true,
    );
  });

  it('rejects a valid status whose identity does not match runtime metadata', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture({ runningInstanceId: 'other-instance' });

    await expect(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        temporaryRoot,
        runCommand: runner.runCommand,
        fetch: healthFetch(runner),
      }),
    ).rejects.toThrow('Preview status identity did not match runtime metadata');
    expect(runner.commands.map(commandLabel).some((label) => label.includes('preview stop'))).toBe(
      true,
    );
  });
});

describe('buildless plugin guidance', () => {
  it('documents dependency-only setup followed by CLI help', () => {
    const setup = readFileSync(join(repositoryRoot, 'commands/synergy-setup.md'), 'utf8');

    expect(setup).toContain('pnpm install --frozen-lockfile');
    expect(setup).toContain('packages/cli/dist/cli.js" --help');
    expect(setup).not.toMatch(/pnpm build|tsup|vite build/u);
  });

  it('contains no fixed loopback origin in user-facing commands or skills', () => {
    const files = [
      ...markdownFiles(join(repositoryRoot, 'commands')),
      ...markdownFiles(join(repositoryRoot, 'skills')),
    ];
    const violations = files.flatMap((file) => {
      const relativePath = relative(repositoryRoot, file);
      return readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          /https?:\/\/(?:localhost|127\.0\.0\.1):4321/u.test(line)
            ? [`${relativePath}:${index + 1}`]
            : [],
        );
    });

    expect(violations).toEqual([]);
  });

  it('describes preview status as runtime-discovered rather than fixed-port PID state', () => {
    const previewControl = readFileSync(
      join(repositoryRoot, 'skills/preview-control/SKILL.md'),
      'utf8',
    );

    expect(previewControl).toContain('preview status --json');
    expect(previewControl).toContain('preferred port');
    expect(previewControl).not.toContain('fixed at `4321`');
    expect(previewControl).not.toContain('.synergy/preview.pid');
  });

  it('uses a shell-safe variable for runtime-discovered daemon URLs', () => {
    const files = markdownFiles(join(repositoryRoot, 'skills'));
    const unsafeCurlExamples = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.includes('curl') && line.includes('<preview-origin>')),
    );

    expect(unsafeCurlExamples).toEqual([]);
  });
});
