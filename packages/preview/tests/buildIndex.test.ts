import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __buildIndex, parsePhaseTitle } from '../vite-plugin-sessions';

function makeTempSessionsDir(files: Record<string, string>): {
  sessionsDir: string;
  cleanup: () => void;
} {
  const sessionsDir = join(
    tmpdir(),
    `synergy-preview-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(sessionsDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return {
    sessionsDir,
    cleanup: () => {
      try {
        rmSync(sessionsDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

describe('parsePhaseTitle', () => {
  it('returns single-quoted title', () => {
    expect(parsePhaseTitle("---\ntitle: 'Foo Bar'\n---\n# h")).toBe('Foo Bar');
  });

  it('returns double-quoted title', () => {
    expect(parsePhaseTitle('---\ntitle: "Foo Bar"\n---\n')).toBe('Foo Bar');
  });

  it('returns unquoted title', () => {
    expect(parsePhaseTitle('---\ntitle: Foo Bar\n---\n')).toBe('Foo Bar');
  });

  it('returns undefined when no frontmatter', () => {
    expect(parsePhaseTitle('# heading only')).toBeUndefined();
  });

  it('returns undefined when no title key', () => {
    expect(parsePhaseTitle('---\norder: 1\n---\n')).toBeUndefined();
  });
});

describe('__buildIndex', () => {
  let temp: ReturnType<typeof makeTempSessionsDir>;

  beforeEach(() => {
    temp = makeTempSessionsDir({});
  });
  afterEach(() => {
    temp.cleanup();
  });

  it('returns empty when sessions dir does not exist', () => {
    expect(__buildIndex(join(temp.sessionsDir, 'nope'))).toEqual([]);
  });

  it('emits a minimal session with only overview', () => {
    const t = makeTempSessionsDir({
      'tiny/00-overview.mdx': '# overview',
    });
    try {
      const idx = __buildIndex(t.sessionsDir);
      expect(idx).toHaveLength(1);
      const s = idx[0]!;
      expect(s.name).toBe('tiny');
      expect(s.specs).toEqual(['00-overview.mdx']);
      expect(s.hasOrchestrator).toBe(false);
      expect(s.phases).toEqual([]);
      expect(s.paths.spec['00-overview.mdx']).toBe(join(t.sessionsDir, 'tiny', '00-overview.mdx'));
      expect(s.paths.orchestrator).toBeUndefined();
      expect(s.paths.phaseSpec).toEqual({});
      expect(s.paths.phaseOrchestrator).toEqual({});
    } finally {
      t.cleanup();
    }
  });

  it('detects root orchestrator and absolute paths', () => {
    const t = makeTempSessionsDir({
      'session-a/00-overview.mdx': '# overview',
      'session-a/orchestrator.md': '# root o',
    });
    try {
      const [s] = __buildIndex(t.sessionsDir);
      expect(s!.hasOrchestrator).toBe(true);
      expect(s!.paths.orchestrator).toBe(join(t.sessionsDir, 'session-a', 'orchestrator.md'));
      expect(s!.paths.session).toBe(join(t.sessionsDir, 'session-a'));
    } finally {
      t.cleanup();
    }
  });

  it('parses phases with titles and orchestrators', () => {
    const t = makeTempSessionsDir({
      'multi/00-overview.mdx': '# o',
      'multi/orchestrator.md': '# root o',
      'multi/phases/01-foundations/spec.mdx': "---\ntitle: 'Foundations'\norder: 1\n---\n# f",
      'multi/phases/01-foundations/orchestrator.md': '# phase 1 o',
      'multi/phases/02-core/spec.mdx': "---\ntitle: 'Core'\norder: 2\n---\n# c",
      'multi/phases/10-finale/spec.mdx': '# no title',
    });
    try {
      const [s] = __buildIndex(t.sessionsDir);
      expect(s!.phases).toHaveLength(3);
      expect(s!.phases.map((p) => p.order)).toEqual([1, 2, 10]);
      expect(s!.phases[0]).toMatchObject({
        order: 1,
        slug: 'foundations',
        folder: '01-foundations',
        title: 'Foundations',
        hasOrchestrator: true,
      });
      expect(s!.phases[1]).toMatchObject({
        order: 2,
        slug: 'core',
        title: 'Core',
        hasOrchestrator: false,
      });
      // Humanized fallback slug.
      expect(s!.phases[2]!.title).toBe('Finale');
      expect(s!.paths.phaseSpec.foundations).toBe(
        join(t.sessionsDir, 'multi', 'phases', '01-foundations', 'spec.mdx'),
      );
      expect(s!.paths.phaseOrchestrator.foundations).toBe(
        join(t.sessionsDir, 'multi', 'phases', '01-foundations', 'orchestrator.md'),
      );
      expect(s!.paths.phaseOrchestrator.core).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });

  it('skips phase folders that do not match NN-slug or lack spec.mdx', () => {
    const t = makeTempSessionsDir({
      'sess/00-overview.mdx': '# o',
      'sess/phases/junk-folder/spec.mdx': '# x',
      'sess/phases/01-good/spec.mdx': '# g',
      'sess/phases/02-no-spec/notes.md': 'oops',
    });
    try {
      const [s] = __buildIndex(t.sessionsDir);
      expect(s!.phases.map((p) => p.slug)).toEqual(['good']);
    } finally {
      t.cleanup();
    }
  });

  it('ignores non-numeric mdx files in session root', () => {
    const t = makeTempSessionsDir({
      'sess/00-overview.mdx': '# o',
      'sess/random.mdx': '# r',
    });
    try {
      const [s] = __buildIndex(t.sessionsDir);
      expect(s!.specs).toEqual(['00-overview.mdx']);
    } finally {
      t.cleanup();
    }
  });

  it('sorts sessions by lastModified desc', () => {
    const t = makeTempSessionsDir({
      'older/00-overview.mdx': '# o',
      'newer/00-overview.mdx': '# o',
    });
    try {
      // Touch newer/ to be more recent. Easiest: rewrite it.
      writeFileSync(join(t.sessionsDir, 'newer', '00-overview.mdx'), '# newer\n');
      const idx = __buildIndex(t.sessionsDir);
      expect(idx[0]!.name).toBe('newer');
      expect(idx[1]!.name).toBe('older');
    } finally {
      t.cleanup();
    }
  });
});
