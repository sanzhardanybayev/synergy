import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const skill = readFileSync(resolve(root, 'skills/review/SKILL.md'), 'utf8');
const command = readFileSync(resolve(root, 'commands/synergy-review.md'), 'utf8');
const analysisSchemaPath = resolve(root, 'packages/cli/src/review-analysis.schema.json');
const benchmarkPath = resolve(root, 'scripts/benchmark-review-analysis.mjs');
const performanceDocumentPath = resolve(root, 'docs/review-performance.md');

describe('synergy review skill contract', () => {
  it('has discoverable frontmatter and a synchronized freshness check', () => {
    expect(skill).toMatch(/^---\nname: review\ndescription: .+\n---/u);
    expect(skill).toMatch(/<!-- synergy-version: \d+\.\d+\.\d+ -->/u);
    expect(skill).toContain('## Step 0 — Freshness check');
    expect(skill).toMatch(/MINE="\d+\.\d+\.\d+"/u);
  });

  it('documents the exact review CLI contracts', () => {
    expect(skill).toContain('review create --pr');
    expect(skill).toContain('review create --staged');
    expect(skill).toContain('review create --unstaged');
    expect(skill).toContain('review create --scope');
    expect(skill).toContain('review refresh <workspace-id>');
    expect(skill).toContain('review analysis-set <workspace@revision> --body-file');
    expect(skill).toContain('review open <workspace@revision>');
    expect(skill).toContain('review status <workspace@revision> --json');
    expect(skill).toContain('review wait <workspace@revision> --for 15m');
    expect(skill).toContain(
      'review answer <question-id> --review <workspace@revision> --body-file',
    );
  });

  it('resolves and threads one absolute consumer project root from nested working directories', () => {
    expect(skill).toContain('git rev-parse --show-toplevel');
    expect(skill).toContain('Resolve `<project-root>` once');
    expect(skill).toContain('<project-root>/.synergy/reviews/');

    const cliInvocations = skill
      .split('\n')
      .filter((line) => line.startsWith('node "<synergy-root>/packages/cli/dist/cli.js"'));
    const reviewOrPreviewInvocations = cliInvocations.filter(
      (line) => line.includes(' review ') || line.includes(' preview start'),
    );

    expect(reviewOrPreviewInvocations.length).toBeGreaterThanOrEqual(12);
    for (const invocation of reviewOrPreviewInvocations) {
      expect(invocation).toContain('--root "<project-root>"');
    }
  });

  it('requires repository-aware concise descriptions and exact-revision answers', () => {
    for (const context of ['imports', 'exports', 'callers', 'types', 'tests', 'configuration']) {
      expect(skill).toContain(context);
    }
    expect(skill).toContain('one or two sentences');
    expect(skill).toContain('low confidence');
    expect(skill).toContain('exact immutable revision');
  });

  it('uses local scope keys and leaves canonical identity derivation to the CLI', () => {
    expect(skill).toContain('"sections": [');
    expect(skill).toContain('"key": "');
    expect(skill).toContain('"sectionKeys"');
    expect(skill).toContain('review-analysis.schema.json');
    expect(skill).not.toContain('@synergy/review-core');
    expect(skill).not.toContain('applyCodeSections');
    expect(skill).not.toMatch(/helper JavaScript/iu);
    expect(skill).not.toMatch(/calculate (?:opaque )?(?:durable )?(?:review )?item IDs/iu);
  });

  it('requires exact captured-line coverage and follows scoped granularity guidance', () => {
    expect(skill).toContain('analysisGuidance');
    expect(skill).toContain('minimumSections');
    expect(skill).toContain('targetSections');
    expect(skill).toContain('maximumSections');
    expect(skill).toContain('scopeTooBroad');
    expect(skill).toMatch(/every captured text line exactly once/iu);
    expect(skill).toMatch(/blank and trailing lines/iu);
    expect(skill).toMatch(/binary files require no sections/iu);
  });

  it('uses JSON analysis output as the preview-independent handoff', () => {
    expect(skill).toContain(
      'review analysis-set <workspace@revision> --body-file <temporary-analysis-json> --json',
    );
    expect(skill).toContain('analysisFinalizedInMs');
    expect(skill).toContain('previewReady');
    expect(skill).toContain('url');
    expect(skill).toMatch(/analysis finalization.*does not depend on preview/isu);
  });

  it('publishes a strict diff-or-scope analysis schema', () => {
    expect(existsSync(analysisSchemaPath)).toBe(true);
    if (!existsSync(analysisSchemaPath)) return;

    const schema = JSON.parse(readFileSync(analysisSchemaPath, 'utf8')) as {
      description?: string;
      oneOf?: Array<Record<string, unknown>>;
    };
    expect(schema.oneOf).toHaveLength(2);
    expect(schema.description).toMatch(/strict structural envelope/iu);
    expect(schema.description).toMatch(/validated semantically by the CLI parser/iu);
    expect(JSON.stringify(schema)).toContain('sectionKeys');
    expect(JSON.stringify(schema)).toContain('reviewItemIds');

    const assertStrictObjects = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) assertStrictObjects(entry);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      const record = value as Record<string, unknown>;
      if (record.type === 'object') expect(record.additionalProperties).toBe(false);
      for (const nested of Object.values(record)) assertStrictObjects(nested);
    };
    assertStrictObjects(schema);
  });

  it('ships an honest five-run performance gate and dogfood record template', () => {
    expect(existsSync(benchmarkPath)).toBe(true);
    expect(existsSync(performanceDocumentPath)).toBe(true);
    if (!existsSync(benchmarkPath) || !existsSync(performanceDocumentPath)) return;

    const benchmark = readFileSync(benchmarkPath, 'utf8');
    const performanceDocument = readFileSync(performanceDocumentPath, 'utf8');
    expect(benchmark).toMatch(/RUN_COUNT\s*=\s*5/u);
    expect(benchmark).toMatch(/MEDIAN_LIMIT_MS\s*=\s*210_000/u);
    expect(benchmark).toMatch(/MAXIMUM_LIMIT_MS\s*=\s*240_000/u);
    for (const phase of ['capture', 'agentAnalysis', 'publication', 'previewReadiness', 'total']) {
      expect(benchmark).toContain(phase);
      expect(performanceDocument).toContain(phase);
    }
    expect(performanceDocument).toMatch(/do not fabricate/iu);
    expect(performanceDocument).toMatch(
      /between the capture command returning and the `analysis-set` command starting/iu,
    );
    expect(performanceDocument).toMatch(/excludes publication/iu);
    expect(performanceDocument).toContain('Environment');
    expect(performanceDocument).toContain('Revision');
    expect(performanceDocument).toContain('Unit count');
    expect(performanceDocument).toContain('Median');
    expect(performanceDocument).toContain('Maximum');
  });

  it('keeps the durable question wait in the foreground and repeats it after answers', () => {
    expect(skill).toContain('Run the wait command in the foreground');
    expect(skill).toMatch(/Never use\s+`nohup`, `&`, or a detached process/u);
    expect(skill).toContain('re-run the wait command');
  });

  it('keeps the Claude command a thin cross-host dispatch shim', () => {
    expect(command).toContain('synergy:review');
    expect(command).toContain('$ARGUMENTS');
    expect(command).toContain('--pr 317');
    expect(command).toContain('--staged');
    expect(command).toContain('--unstaged');
    expect(command).toContain('--scope features/subscriptions');
    expect(command).toContain('--resume <workspace@revision>');
    expect(command).not.toContain('analysis-set');
    expect(command).not.toContain('review wait');
  });
});
