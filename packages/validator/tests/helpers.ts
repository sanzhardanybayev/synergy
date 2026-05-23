import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Build a temporary project root with one or more sessions on disk for
 * the validator to inspect. Returns the absolute path to the project root
 * plus a cleanup function.
 */
export function makeTempProject(files: Record<string, string>): {
  projectRoot: string;
  cleanup: () => void;
} {
  const projectRoot = join(
    tmpdir(),
    `synergy-validator-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  for (const [relPath, contents] of Object.entries(files)) {
    const abs = join(projectRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return {
    projectRoot,
    cleanup: () => {
      try {
        rmSync(projectRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Convenience: produce a minimal valid `00-overview.mdx` body with Summary +
 * Goals headings.
 */
export function minimalOverview(title = 'Test session'): string {
  return `---
title: '${title}'
---

# ${title}

## Summary

A test.

## Goals

- Test the validator.
`;
}

/**
 * Convenience: a minimal phase `spec.mdx` body with a single anchor.
 */
export function minimalPhaseSpec(title: string, order: number): string {
  return `---
title: '${title}'
order: ${order}
---

# Phase ${order}: ${title}

## Goal

A short phase used in tests.

## Tasks

- One task.
`;
}
