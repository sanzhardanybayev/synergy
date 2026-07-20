import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cac from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewNotReadyError } from './review-actions.js';
import {
  type ReviewCliDependencies,
  createReviewSourceFromFlags,
  registerReviewCommands,
  runReviewWaitCommand,
} from './review-cli.js';

interface CliResult {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

async function runReviewCli(
  args: string[],
  dependencies: ReviewCliDependencies = {},
): Promise<CliResult> {
  const cli = cac('synergy');
  registerReviewCommands(cli, dependencies);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    cli.parse(['node', 'synergy', 'review', ...args], { run: false });
    await cli.runMatchedCommand();
    return { exitCode: process.exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    process.exitCode = previousExitCode;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe('review CLI source flags', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  it('requires exactly one source selector', () => {
    expect(() => createReviewSourceFromFlags({ staged: true, unstaged: true })).toThrow(
      /exactly one/i,
    );
    expect(() => createReviewSourceFromFlags({})).toThrow(/exactly one/i);
  });

  it('maps a scope selector to a repository-relative capture request', () => {
    expect(createReviewSourceFromFlags({ scope: 'src/features' })).toEqual({
      kind: 'scope',
      patterns: ['src/features'],
    });
  });

  it('rejects invalid usage before attempting Git root resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-cli-body-'));
    temporaryRoots.push(root);
    const malformedBody = join(root, 'invalid.json');
    writeFileSync(malformedBody, '{invalid', 'utf8');
    const cases = [
      ['create', 'unexpected', '--staged', '--root', '/not-a-repository'],
      [
        'analysis-set',
        'workspace@revision',
        '--body-file',
        malformedBody,
        '--root',
        '/not-a-repository',
      ],
      ['analysis-set', 'workspace@revision', '--json', '--body-file', malformedBody],
      ['refresh', '../invalid', '--root', '/not-a-repository'],
      ['status', 'malformed-reference', '--root', '/not-a-repository'],
      ['wait', 'workspace@revision', '--for', 'not-a-duration', '--root', '/not-a-repository'],
      ['answer', 'question-1', '--review', 'workspace@revision', '--root', '/not-a-repository'],
      ['list', '--unknown-option', '--root', '/not-a-repository'],
      ['unknown-action', '--root', '/not-a-repository'],
    ];

    for (const args of cases) {
      const result = await runReviewCli(args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/Error:/);
      expect(result.stderr).not.toMatch(/Git capture|repository root/i);
    }
  });

  it('reports strict analysis validation failures with exact JSON paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-cli-analysis-'));
    temporaryRoots.push(root);
    const validItem = {
      reviewItemId: 'item-1',
      description: 'Explains the captured change.',
      confidence: 'high',
      evidencePaths: ['src/example.ts'],
    };
    const validGroup = {
      id: 'example',
      label: 'Example',
      reviewItemIds: ['item-1'],
    };
    const cases: Array<{ body: string; expectedPath: string; name: string }> = [
      { name: 'invalid JSON', body: '{invalid', expectedPath: '$' },
      {
        name: 'unknown nested key',
        body: JSON.stringify({
          groups: [validGroup],
          items: [{ ...validItem, extra: true }],
        }),
        expectedPath: '$.items[0].extra',
      },
      {
        name: 'mixed contracts',
        body: JSON.stringify({
          groups: [validGroup],
          items: [validItem],
          sections: [],
        }),
        expectedPath: '$.items',
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const bodyFile = join(root, `analysis-${index}.json`);
      writeFileSync(bodyFile, testCase.body, 'utf8');

      const result = await runReviewCli([
        'analysis-set',
        'workspace@revision',
        '--body-file',
        bodyFile,
        '--root',
        '/not-a-repository',
      ]);

      expect(result.exitCode, testCase.name).toBe(2);
      expect(result.stdout, testCase.name).toBe('');
      expect(result.stderr, testCase.name).toContain(testCase.expectedPath);
      expect(result.stderr, testCase.name).not.toMatch(/Git capture|repository root/i);
    }
  });

  it('passes parsed scope local-key analysis to the review action', async () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-cli-scope-analysis-'));
    temporaryRoots.push(root);
    execFileSync('git', ['init', '--quiet', root]);
    const bodyFile = join(root, 'analysis.json');
    const analysis = {
      groups: [{ id: 'module', label: 'Module', sectionKeys: ['local-section'] }],
      sections: [
        {
          key: 'local-section',
          path: 'src/example.ts',
          label: 'Example',
          start: 1,
          end: 1,
          description: 'Explains the example module in repository context.',
          confidence: 'high',
          evidencePaths: ['src/example.ts'],
        },
      ],
    };
    writeFileSync(bodyFile, JSON.stringify(analysis), 'utf8');
    let applied: unknown;
    const humanTicks = [100, 101, 104];

    const result = await runReviewCli(
      ['analysis-set', 'workspace@revision', '--body-file', bodyFile, '--root', root],
      {
        monotonicNow: () => {
          const tick = humanTicks.shift();
          if (tick === undefined) throw new Error('unexpected human CLI timing read');
          return tick;
        },
        applyReviewAnalysis: async (request) => {
          applied = request;
          return {
            reference: `${request.reference.workspaceId}@${request.reference.revisionId}`,
            analysisFinalized: true,
            reviewItemCount: 1,
            groupCount: 1,
            withinRecommendedRange: true,
            analysisFinalizedInMs: 1,
            route: '/r/workspace/revision',
            previewReady: false,
            timings: {
              parsingMs: 1,
              derivationMs: 0,
              validationMs: 1,
              publicationMs: 1,
              previewResolutionMs: 1,
              totalMs: 4,
            },
          };
        },
      },
    );

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('analysis recorded');
    expect(applied).toMatchObject({
      root: realpathSync(root),
      reference: { workspaceId: 'workspace', revisionId: 'revision' },
      analysis: { kind: 'scope', ...analysis },
      parsingInMs: 3,
      commandStartedAt: 100,
    });
    expect(humanTicks).toEqual([]);

    const jsonTicks = [200, 202, 207];
    const jsonResult = await runReviewCli(
      ['analysis-set', 'workspace@revision', '--body-file', bodyFile, '--root', root, '--json'],
      {
        monotonicNow: () => {
          const tick = jsonTicks.shift();
          if (tick === undefined) throw new Error('unexpected JSON CLI timing read');
          return tick;
        },
        applyReviewAnalysis: async () => ({
          reference: 'workspace@revision',
          analysisFinalized: true,
          reviewItemCount: 1,
          groupCount: 1,
          withinRecommendedRange: true,
          analysisFinalizedInMs: 1,
          route: '/r/workspace/revision',
          previewReady: true,
          url: 'http://127.0.0.1:4321/r/workspace/revision',
          timings: {
            parsingMs: 1,
            derivationMs: 1,
            validationMs: 1,
            publicationMs: 1,
            previewResolutionMs: 1,
            totalMs: 5,
          },
        }),
      },
    );
    expect(jsonResult.stderr).toBe('');
    expect(jsonResult.exitCode).toBeUndefined();
    expect(jsonTicks).toEqual([]);
    expect(JSON.parse(jsonResult.stdout)).toEqual({
      reference: 'workspace@revision',
      analysisFinalized: true,
      reviewItemCount: 1,
      groupCount: 1,
      withinRecommendedRange: true,
      analysisFinalizedInMs: 1,
      route: '/r/workspace/revision',
      previewReady: true,
      url: 'http://127.0.0.1:4321/r/workspace/revision',
      timings: {
        parsingMs: 1,
        derivationMs: 1,
        validationMs: 1,
        publicationMs: 1,
        previewResolutionMs: 1,
        totalMs: 5,
      },
    });
  });

  it('executes list through CAC from a nested directory using the canonical Git root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-cli-'));
    temporaryRoots.push(root);
    const nested = join(root, 'src', 'nested');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '--quiet', root]);

    const result = await runReviewCli(['list', '--root', nested, '--json']);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it('awaits open and returns typed nonzero JSON when preview is not ready', async () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-cli-open-json-'));
    temporaryRoots.push(root);
    execFileSync('git', ['init', '--quiet', root]);
    const canonicalRoot = realpathSync(root);
    let openSettled = false;

    const result = await runReviewCli(['open', 'workspace@revision', '--root', root, '--json'], {
      openReview: async (requestedRoot) => {
        expect(requestedRoot).toBe(canonicalRoot);
        await Promise.resolve();
        openSettled = true;
        throw new PreviewNotReadyError(requestedRoot);
      },
    });

    expect(openSettled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      error: 'preview_not_ready',
      message: `Preview is not ready for project root ${JSON.stringify(canonicalRoot)}. Invoke the Synergy executable with argv ${JSON.stringify(['preview', 'start', '--root', canonicalRoot])}.`,
      root: canonicalRoot,
      suggestedCommand: {
        command: 'synergy',
        args: ['preview', 'start', '--root', canonicalRoot],
      },
    });
  });

  it('preserves text error output when preview is not ready', async () => {
    const root = mkdtempSync(join(tmpdir(), 'synergy-review-cli-open-text-'));
    temporaryRoots.push(root);
    execFileSync('git', ['init', '--quiet', root]);

    const result = await runReviewCli(['open', 'workspace@revision', '--root', root], {
      openReview: async () => {
        throw new PreviewNotReadyError(root);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      `Error: Preview is not ready for project root ${JSON.stringify(root)}. Invoke the Synergy executable with argv ${JSON.stringify(['preview', 'start', '--root', root])}.`,
    );
    expect(result.stderr).not.toContain('synergy preview start --root');
  });

  it('removes direct wait signal handlers after success and failure', async () => {
    const initialInterruptListeners = process.listenerCount('SIGINT');
    const initialTerminateListeners = process.listenerCount('SIGTERM');
    const base = {
      root: '/repository',
      reference: { workspaceId: 'workspace', revisionId: 'revision' },
      listenerId: 'listener-1',
    };

    await runReviewWaitCommand({
      ...base,
      wait: async () => ({ status: 'timeout', listenerId: 'listener-1', questions: [] }),
    });
    expect(process.listenerCount('SIGINT')).toBe(initialInterruptListeners);
    expect(process.listenerCount('SIGTERM')).toBe(initialTerminateListeners);

    await expect(
      runReviewWaitCommand({
        ...base,
        wait: async () => {
          throw new Error('wait failed');
        },
      }),
    ).rejects.toThrow('wait failed');
    expect(process.listenerCount('SIGINT')).toBe(initialInterruptListeners);
    expect(process.listenerCount('SIGTERM')).toBe(initialTerminateListeners);
  });
});
