import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REQUIRED_RUNTIME_ARTIFACTS,
  assertRuntimeArtifacts,
  inspectRuntimeArtifacts,
} from '../src/artifacts.js';

interface ArtifactFixture {
  root: string;
  remove(path: string): void;
  write(path: string, contents?: string): void;
  track(path: string): void;
}

const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function makeArtifactFixture(): ArtifactFixture {
  const root = mkdtempSync(join(tmpdir(), 'synergy-artifacts-'));
  fixtures.push(root);

  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'artifact-test@example.test']);
  git(root, ['config', 'user.name', 'Artifact Test']);

  for (const path of REQUIRED_RUNTIME_ARTIFACTS) {
    const destination = join(root, path);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, `artifact: ${path}\n`, 'utf8');
  }
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'runtime artifacts']);

  return {
    root,
    remove(path) {
      unlinkSync(join(root, path));
    },
    write(path, contents = `artifact: ${path}\n`) {
      const destination = join(root, path);
      mkdirSync(join(destination, '..'), { recursive: true });
      writeFileSync(destination, contents, 'utf8');
    },
    track(path) {
      git(root, ['add', '--', path]);
      git(root, ['commit', '--quiet', '-m', `track ${path}`]);
    },
  };
}

describe('runtime artifact contract', () => {
  it('accepts a complete tracked artifact fixture', () => {
    const fixture = makeArtifactFixture();

    expect(inspectRuntimeArtifacts(fixture.root)).toEqual({
      missing: [],
      untracked: [],
      drifted: [],
      forbidden: [],
    });
    expect(() => assertRuntimeArtifacts(fixture.root)).not.toThrow();
  });

  it('reports missing required artifacts', () => {
    const fixture = makeArtifactFixture();
    fixture.remove('packages/cli/dist/cli.js');

    expect(inspectRuntimeArtifacts(fixture.root).missing).toEqual(['packages/cli/dist/cli.js']);
  });

  it('reports untracked generated chunks', () => {
    const fixture = makeArtifactFixture();
    fixture.write('packages/cli/dist/chunks/runtime.js');

    expect(inspectRuntimeArtifacts(fixture.root).untracked).toEqual([
      'packages/cli/dist/chunks/runtime.js',
    ]);
  });

  it('requires the non-static source capture worker', () => {
    const fixture = makeArtifactFixture();
    fixture.remove('packages/review-core/dist/source-capture-worker.js');

    expect(inspectRuntimeArtifacts(fixture.root).missing).toContain(
      'packages/review-core/dist/source-capture-worker.js',
    );
  });

  it('reports drift after a simulated build', () => {
    const fixture = makeArtifactFixture();
    fixture.write('packages/spec-kit/dist/index.js', 'rebuilt artifact\n');

    expect(inspectRuntimeArtifacts(fixture.root).drifted).toEqual([
      'packages/spec-kit/dist/index.js',
    ]);
  });

  it('forbids tracked node_modules paths', () => {
    const fixture = makeArtifactFixture();
    const path = 'packages/cli/node_modules/unsafe/index.js';
    fixture.write(path);
    fixture.track(path);

    expect(existsSync(join(fixture.root, path))).toBe(true);
    expect(inspectRuntimeArtifacts(fixture.root).forbidden).toEqual([path]);
  });
});
