import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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
  for (const artifact of REQUIRED_RUNTIME_ARTIFACTS) {
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

interface RunnerFixture {
  commands: SmokeCommand[];
  events: string[];
  runCommand: SmokeCommandRunner;
}

function makeRunnerFixture(
  options: { omittedArtifact?: string; mutateOnStop?: boolean } = {},
): RunnerFixture {
  const commands: SmokeCommand[] = [];
  const events: string[] = [];
  const runCommand: SmokeCommandRunner = async (invocation) => {
    commands.push(invocation);
    const label = commandLabel(invocation);
    events.push(label);

    if (invocation.command === 'tar') {
      const destinationIndex = invocation.args.indexOf('-C') + 1;
      writeArchive(invocation.args[destinationIndex] ?? '', options.omittedArtifact);
    }

    if (label.includes('preview start')) {
      const rootIndex = invocation.args.indexOf('--root') + 1;
      const fixtureRoot = invocation.args[rootIndex] ?? '';
      const runtimeFile = join(fixtureRoot, '.synergy/preview.runtime.json');
      mkdirSync(join(runtimeFile, '..'), { recursive: true });
      writeFileSync(
        runtimeFile,
        `${JSON.stringify({ origin: 'http://127.0.0.1:4567' })}\n`,
        'utf8',
      );
    }

    if (options.mutateOnStop && label.includes('preview stop')) {
      writeFileSync(
        join(invocation.cwd, 'packages/cli/dist/cli.js'),
        'mutated runtime artifact\n',
        'utf8',
      );
    }

    return { stdout: label.includes('review create') ? '{"reference":"fixture@revision"}\n' : '' };
  };

  return { commands, events, runCommand };
}

describe('plugin archive smoke', () => {
  it('runs the committed archive without a build and verifies preview health', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture();
    const requestedUrls: string[] = [];

    await runPluginArchiveSmoke({
      repositoryRoot: '/repository',
      temporaryRoot,
      runCommand: runner.runCommand,
      fetch: async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        runner.events.push(`fetch ${url}`);
        return new Response(JSON.stringify({ state: 'ready' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
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
    expect(labels.some((label) => /(?:^|\s)(?:build|tsup|vite)(?:\s|$)/u.test(label))).toBe(false);
    expect(requestedUrls).toEqual(['http://127.0.0.1:4567/api/runtime/health']);
    expect(runner.events.indexOf('fetch http://127.0.0.1:4567/api/runtime/health')).toBeLessThan(
      runner.events.findIndex((event) => event.includes('preview stop')),
    );
  });

  it('rejects an archive missing a required artifact before installation', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture({
      omittedArtifact: 'packages/review-core/dist/source-capture-worker.js',
    });

    await expect(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        temporaryRoot,
        runCommand: runner.runCommand,
        fetch: async () => new Response('{}', { status: 200 }),
      }),
    ).rejects.toThrow('packages/review-core/dist/source-capture-worker.js');
    expect(runner.commands.map(commandLabel)).not.toContain('pnpm install --frozen-lockfile');
  });

  it('fails when smoke execution changes a runtime artifact', async () => {
    const temporaryRoot = makeTemporaryRoot();
    const runner = makeRunnerFixture({ mutateOnStop: true });

    await expect(
      runPluginArchiveSmoke({
        repositoryRoot: '/repository',
        temporaryRoot,
        runCommand: runner.runCommand,
        fetch: async () =>
          new Response(JSON.stringify({ state: 'ready' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toThrow('Runtime artifact changed during archive smoke: packages/cli/dist/cli.js');
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
