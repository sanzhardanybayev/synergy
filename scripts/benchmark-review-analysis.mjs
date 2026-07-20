#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_COUNT = 5;
const MEDIAN_LIMIT_MS = 210_000;
const MAXIMUM_LIMIT_MS = 240_000;
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    'Usage: node scripts/benchmark-review-analysis.mjs --fixture <replay.json> --root <project-root> [--cli <cli.js>]\n',
  );
  process.exit(message ? 2 : 0);
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') usage();
    if (argument !== '--fixture' && argument !== '--root' && argument !== '--cli') {
      usage(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`${argument} requires a value`);
    result[argument.slice(2)] = value;
    index += 1;
  }
  if (!result.fixture || !result.root) usage('--fixture and --root are required');
  return result;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertString(value, path) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a string`);
  return value;
}

function assertNonnegativeNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a nonnegative finite number`);
  }
  return value;
}

function assertCreateArgs(value, path) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${path} must be an array of strings`);
  }
  const valid =
    (value.length === 1 && (value[0] === '--staged' || value[0] === '--unstaged')) ||
    (value.length === 2 && (value[0] === '--scope' || value[0] === '--pr') && value[1].length > 0);
  if (!valid) {
    throw new Error(`${path} must contain exactly one supported review create selector`);
  }
  return [...value];
}

function readFixture(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.runs)) {
    throw new Error('fixture must contain schemaVersion 1 and a runs array');
  }
  if (value.runs.length !== RUN_COUNT) {
    throw new Error(`fixture must contain exactly ${RUN_COUNT} runs`);
  }
  return value.runs.map((run, index) => {
    const pathPrefix = `runs[${index}]`;
    if (!isRecord(run)) throw new Error(`${pathPrefix} must be an object`);
    return {
      label: assertString(run.label, `${pathPrefix}.label`),
      createArgs: assertCreateArgs(run.createArgs, `${pathPrefix}.createArgs`),
      analysisBodyFile: assertString(run.analysisBodyFile, `${pathPrefix}.analysisBodyFile`),
      agentAnalysisMs: assertNonnegativeNumber(
        run.agentAnalysisMs,
        `${pathPrefix}.agentAnalysisMs`,
      ),
    };
  });
}

function commandFailure(cli, args, result) {
  const detail = [result.stderr, result.stdout]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .trim();
  return new Error(
    `${process.execPath} ${cli} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}${detail ? `\n${detail}` : ''}`,
  );
}

function runCli(cli, args) {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const durationMs = performance.now() - startedAt;
  if (result.error) throw result.error;
  if (result.status !== 0) throw commandFailure(cli, args, result);
  return { durationMs, stdout: result.stdout };
}

function parseJsonOutput(output, phase) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${phase} did not return one JSON document`);
  }
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function resolveFixturePath(fixturePath, referencedPath) {
  return isAbsolute(referencedPath)
    ? referencedPath
    : resolve(dirname(fixturePath), referencedPath);
}

function main() {
  const argumentsByName = parseArguments(process.argv.slice(2));
  const fixturePath = resolve(argumentsByName.fixture);
  const projectRoot = resolve(argumentsByName.root);
  const cli = resolve(argumentsByName.cli ?? resolve(scriptRoot, 'packages/cli/dist/cli.js'));
  const fixtureRuns = readFixture(fixturePath);

  // Establish one healthy process before timing. Each fixture entry must still address an
  // independent pending revision so the immutable analysis publication is exercised five times.
  runCli(cli, ['preview', 'start', '--root', projectRoot]);

  const runs = fixtureRuns.map((fixtureRun, index) => {
    const capture = runCli(cli, [
      'review',
      'create',
      ...fixtureRun.createArgs,
      '--json',
      '--root',
      projectRoot,
    ]);
    const captureResult = parseJsonOutput(capture.stdout, `run ${index + 1} capture`);
    if (!isRecord(captureResult) || typeof captureResult.reference !== 'string') {
      throw new Error(`run ${index + 1} capture did not return a reference`);
    }
    if (captureResult.analysisRequired !== true) {
      throw new Error(
        `run ${index + 1} resumed finalized analysis; use five independent pending fixture revisions`,
      );
    }

    const publication = runCli(cli, [
      'review',
      'analysis-set',
      captureResult.reference,
      '--body-file',
      resolveFixturePath(fixturePath, fixtureRun.analysisBodyFile),
      '--json',
      '--root',
      projectRoot,
    ]);
    const publicationResult = parseJsonOutput(publication.stdout, `run ${index + 1} publication`);
    if (!isRecord(publicationResult) || publicationResult.reference !== captureResult.reference) {
      throw new Error(`run ${index + 1} publication returned the wrong review reference`);
    }

    let previewReadinessMs = 0;
    if (publicationResult.previewReady !== true || typeof publicationResult.url !== 'string') {
      const previewStart = runCli(cli, ['preview', 'start', '--root', projectRoot]);
      const reviewOpen = runCli(cli, [
        'review',
        'open',
        captureResult.reference,
        '--json',
        '--root',
        projectRoot,
      ]);
      previewReadinessMs = previewStart.durationMs + reviewOpen.durationMs;
      const openResult = parseJsonOutput(reviewOpen.stdout, `run ${index + 1} preview readiness`);
      if (!isRecord(openResult) || typeof openResult.url !== 'string') {
        throw new Error(`run ${index + 1} did not produce a ready review URL`);
      }
    }

    const totalMs =
      capture.durationMs + fixtureRun.agentAnalysisMs + publication.durationMs + previewReadinessMs;
    return {
      run: index + 1,
      label: fixtureRun.label,
      reference: captureResult.reference,
      reviewItemCount:
        typeof publicationResult.reviewItemCount === 'number'
          ? publicationResult.reviewItemCount
          : null,
      phasesMs: {
        capture: capture.durationMs,
        agentAnalysis: fixtureRun.agentAnalysisMs,
        publication: publication.durationMs,
        previewReadiness: previewReadinessMs,
        total: totalMs,
      },
      previewReady: true,
    };
  });

  const totals = runs.map((run) => run.phasesMs.total);
  const medianMs = median(totals);
  const maximumMs = Math.max(...totals);
  const passed = medianMs <= MEDIAN_LIMIT_MS && maximumMs <= MAXIMUM_LIMIT_MS;
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: 'fixture-replay-with-recorded-agent-intervals',
        thresholdsMs: { median: MEDIAN_LIMIT_MS, maximum: MAXIMUM_LIMIT_MS },
        runs,
        summary: { runCount: RUN_COUNT, median: medianMs, maximum: maximumMs, passed },
      },
      null,
      2,
    )}\n`,
  );
  if (!passed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Review analysis benchmark failed: ${message}\n`);
  process.exitCode = 1;
}
