import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const skill = readFileSync(resolve(root, 'skills/review/SKILL.md'), 'utf8');
const command = readFileSync(resolve(root, 'commands/synergy-review.md'), 'utf8');

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
