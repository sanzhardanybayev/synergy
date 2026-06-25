import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listPhases, validatePhaseStructure } from '../src/phase.js';
import { makeTempProject, minimalPhaseSpec } from './helpers.js';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});

function project(files: Record<string, string>): string {
  const { projectRoot, cleanup } = makeTempProject(files);
  cleanups.push(cleanup);
  return projectRoot;
}

const SESSION = '.synergy/sessions/s1';

describe('listPhases', () => {
  it('returns empty list when phases/ does not exist', () => {
    const root = project({ [`${SESSION}/00-overview.mdx`]: '# t' });
    const phases = listPhases(`${root}/${SESSION}`);
    expect(phases).toEqual([]);
  });

  it('lists phase folders in numeric order', () => {
    const root = project({
      [`${SESSION}/phases/01-foundation/spec.mdx`]: minimalPhaseSpec('Foundation', 1),
      [`${SESSION}/phases/02-core/spec.mdx`]: minimalPhaseSpec('Core', 2),
      [`${SESSION}/phases/03-polish/spec.mdx`]: minimalPhaseSpec('Polish', 3),
    });
    const phases = listPhases(`${root}/${SESSION}`);
    expect(phases.map((p) => p.slug)).toEqual(['foundation', 'core', 'polish']);
    expect(phases.map((p) => p.order)).toEqual([1, 2, 3]);
  });

  it('skips non-directory entries under phases/', () => {
    const root = project({
      [`${SESSION}/phases/01-foundation/spec.mdx`]: minimalPhaseSpec('Foundation', 1),
      [`${SESSION}/phases/README.txt`]: 'ignore me',
    });
    const phases = listPhases(`${root}/${SESSION}`);
    expect(phases.map((p) => p.slug)).toEqual(['foundation']);
  });

  it('captures malformed folder names so the validator can report them', () => {
    const root = project({
      [`${SESSION}/phases/01-foundation/spec.mdx`]: minimalPhaseSpec('Foundation', 1),
      [`${SESSION}/phases/nope/spec.mdx`]: minimalPhaseSpec('Nope', 2),
    });
    const phases = listPhases(`${root}/${SESSION}`);
    const bad = phases.find((p) => p.folderName === 'nope');
    expect(bad).toBeDefined();
    expect(bad?.malformed).toBe(true);
  });
});

describe('validatePhaseStructure', () => {
  it('returns zero issues for a clean 3-phase session', () => {
    const root = project({
      [`${SESSION}/phases/01-foundation/spec.mdx`]: minimalPhaseSpec('Foundation', 1),
      [`${SESSION}/phases/01-foundation/orchestrator.md`]: '# o',
      [`${SESSION}/phases/02-core/spec.mdx`]: minimalPhaseSpec('Core', 2),
      [`${SESSION}/phases/02-core/orchestrator.md`]: '# o',
      [`${SESSION}/phases/03-polish/spec.mdx`]: minimalPhaseSpec('Polish', 3),
      [`${SESSION}/phases/03-polish/orchestrator.md`]: '# o',
    });
    const issues = validatePhaseStructure(`${root}/${SESSION}`);
    expect(issues).toEqual([]);
  });

  it('returns zero issues when phases/ is absent', () => {
    const root = project({ [`${SESSION}/00-overview.mdx`]: '# t' });
    const issues = validatePhaseStructure(`${root}/${SESSION}`);
    expect(issues).toEqual([]);
  });

  it('errors on duplicate NN', () => {
    const root = project({
      [`${SESSION}/phases/01-foundation/spec.mdx`]: minimalPhaseSpec('Foundation', 1),
      [`${SESSION}/phases/01-core/spec.mdx`]: minimalPhaseSpec('Core', 1),
    });
    const issues = validatePhaseStructure(`${root}/${SESSION}`);
    const dup = issues.find((i) => /duplicate/i.test(i.message));
    expect(dup).toBeDefined();
    expect(dup?.severity).toBe('error');
  });

  it('errors on gap in NN sequence', () => {
    const root = project({
      [`${SESSION}/phases/01-foundation/spec.mdx`]: minimalPhaseSpec('Foundation', 1),
      [`${SESSION}/phases/02-core/spec.mdx`]: minimalPhaseSpec('Core', 2),
      [`${SESSION}/phases/04-polish/spec.mdx`]: minimalPhaseSpec('Polish', 4),
    });
    const issues = validatePhaseStructure(`${root}/${SESSION}`);
    const gap = issues.find((i) => /gap/i.test(i.message) || /missing/i.test(i.message));
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('error');
  });

  it('errors when sequence does not start at 1', () => {
    const root = project({
      [`${SESSION}/phases/02-foundation/spec.mdx`]: minimalPhaseSpec('Foundation', 2),
      [`${SESSION}/phases/03-core/spec.mdx`]: minimalPhaseSpec('Core', 3),
    });
    const issues = validatePhaseStructure(`${root}/${SESSION}`);
    const start = issues.find((i) => /1|start/i.test(i.message));
    expect(start).toBeDefined();
    expect(start?.severity).toBe('error');
  });

  it('errors on missing spec.mdx in a phase folder', () => {
    const root = project({
      [`${SESSION}/phases/01-foundation/orchestrator.md`]: '# o',
    });
    const issues = validatePhaseStructure(`${root}/${SESSION}`);
    const missing = issues.find((i) => /spec\.mdx/i.test(i.message));
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe('error');
  });

  it('warns on missing orchestrator.md in a phase folder', () => {
    const root = project({
      [`${SESSION}/phases/01-foundation/spec.mdx`]: minimalPhaseSpec('Foundation', 1),
    });
    const issues = validatePhaseStructure(`${root}/${SESSION}`);
    const warn = issues.find((i) => /orchestrator\.md/i.test(i.message));
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('warning');
  });

  it('errors when slug is not kebab-case', () => {
    const root = project({
      [`${SESSION}/phases/01-Foundation_Bad/spec.mdx`]: minimalPhaseSpec('Bad', 1),
    });
    const issues = validatePhaseStructure(`${root}/${SESSION}`);
    const bad = issues.find((i) => /kebab|slug/i.test(i.message));
    expect(bad).toBeDefined();
    expect(bad?.severity).toBe('error');
  });

  it('errors when slug exceeds 40 chars', () => {
    const longSlug = 'a'.repeat(41);
    const root = project({
      [`${SESSION}/phases/01-${longSlug}/spec.mdx`]: minimalPhaseSpec('Long', 1),
    });
    const issues = validatePhaseStructure(`${root}/${SESSION}`);
    const tooLong = issues.find((i) => /40|long|length/i.test(i.message));
    expect(tooLong).toBeDefined();
    expect(tooLong?.severity).toBe('error');
  });

  it('errors when folder name does not match NN-<slug>', () => {
    const root = project({
      [`${SESSION}/phases/badname/spec.mdx`]: minimalPhaseSpec('Bad', 1),
    });
    const issues = validatePhaseStructure(`${root}/${SESSION}`);
    const malformed = issues.find((i) => /name|format|match/i.test(i.message));
    expect(malformed).toBeDefined();
    expect(malformed?.severity).toBe('error');
  });
});

let sessionDir: string;
beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'synergy-phase-'));
});
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

function phase(nn: string, slug: string, body: string) {
  const dir = join(sessionDir, 'phases', `${nn}-${slug}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.mdx'), body, 'utf8');
  writeFileSync(join(dir, 'orchestrator.md'), '# orch\n', 'utf8');
}

describe('validatePhaseStructure — title warning', () => {
  it('warns when a phase spec.mdx has no frontmatter title', () => {
    phase('01', 'storage', '---\norder: 1\n---\n# storage\n');
    const issues = validatePhaseStructure(sessionDir);
    expect(
      issues.some((i) => i.severity === 'warning' && /missing a `title`/.test(i.message)),
    ).toBe(true);
  });

  it('does not warn when a title is present', () => {
    phase('01', 'storage', "---\ntitle: 'Storage layer'\norder: 1\n---\n# storage\n");
    const issues = validatePhaseStructure(sessionDir);
    expect(issues.some((i) => /missing a `title`/.test(i.message))).toBe(false);
  });
});
