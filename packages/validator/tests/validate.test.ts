import { afterEach, describe, expect, it } from 'vitest';
import { validate } from '../src/validate.js';
import { makeTempProject, minimalOverview, minimalPhaseSpec } from './helpers.js';

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

const SESSION_REL = '.synergy/sessions/s1';

describe('validate — happy path', () => {
  it('passes a minimal session with just overview + orchestrator', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: minimalOverview('Minimal session'),
      [`${SESSION_REL}/orchestrator.md`]: '# Orchestrator',
    });
    const report = validate({ projectRoot: root });
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('passes a single-phase session', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: minimalOverview('Single phase'),
      [`${SESSION_REL}/orchestrator.md`]: '# o',
      [`${SESSION_REL}/phases/01-core/spec.mdx`]: minimalPhaseSpec('Core', 1),
      [`${SESSION_REL}/phases/01-core/orchestrator.md`]: '# o',
    });
    const report = validate({ projectRoot: root });
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });
});

describe('validate — phase folder validation integration', () => {
  it('errors on a phase folder missing spec.mdx', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: minimalOverview('phased'),
      [`${SESSION_REL}/phases/01-core/orchestrator.md`]: '# o',
    });
    const report = validate({ projectRoot: root });
    const err = report.issues.find((i) => i.severity === 'error' && /spec\.mdx/i.test(i.message));
    expect(err).toBeDefined();
  });

  it('warns on a phase folder missing orchestrator.md', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: minimalOverview('phased'),
      [`${SESSION_REL}/phases/01-core/spec.mdx`]: minimalPhaseSpec('Core', 1),
    });
    const report = validate({ projectRoot: root });
    const warn = report.issues.find(
      (i) => i.severity === 'warning' && /orchestrator\.md/i.test(i.message),
    );
    expect(warn).toBeDefined();
  });
});

describe('validate — CrossRef resolution', () => {
  it('resolves new-form CrossRef to="phases/<slug>"', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: `---
title: 't'
---
import { CrossRef } from '@synergy/spec-kit';

# Title

## Summary

See <CrossRef to="phases/core" />.

## Goals

- One.
`,
      [`${SESSION_REL}/phases/01-core/spec.mdx`]: minimalPhaseSpec('Core', 1),
      [`${SESSION_REL}/phases/01-core/orchestrator.md`]: '# o',
    });
    const report = validate({ projectRoot: root });
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('resolves new-form CrossRef with anchor against phase headings', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: `---
title: 't'
---
import { CrossRef } from '@synergy/spec-kit';

# Title

## Summary

See <CrossRef to="phases/core#tasks" />.

## Goals

- One.
`,
      [`${SESSION_REL}/phases/01-core/spec.mdx`]: minimalPhaseSpec('Core', 1),
      [`${SESSION_REL}/phases/01-core/orchestrator.md`]: '# o',
    });
    const report = validate({ projectRoot: root });
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('errors when new-form CrossRef targets a missing phase slug', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: `---
title: 't'
---
import { CrossRef } from '@synergy/spec-kit';

# Title

## Summary

See <CrossRef to="phases/nope" />.

## Goals

- One.
`,
      [`${SESSION_REL}/phases/01-core/spec.mdx`]: minimalPhaseSpec('Core', 1),
      [`${SESSION_REL}/phases/01-core/orchestrator.md`]: '# o',
    });
    const report = validate({ projectRoot: root });
    const err = report.issues.find((i) => i.severity === 'error' && /phases\/nope/.test(i.message));
    expect(err).toBeDefined();
  });

  it('errors when new-form CrossRef anchor is missing in the phase spec', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: `---
title: 't'
---
import { CrossRef } from '@synergy/spec-kit';

# Title

## Summary

See <CrossRef to="phases/core#missing-anchor" />.

## Goals

- One.
`,
      [`${SESSION_REL}/phases/01-core/spec.mdx`]: minimalPhaseSpec('Core', 1),
      [`${SESSION_REL}/phases/01-core/orchestrator.md`]: '# o',
    });
    const report = validate({ projectRoot: root });
    const err = report.issues.find(
      (i) => i.severity === 'error' && /missing-anchor/.test(i.message),
    );
    expect(err).toBeDefined();
  });

  it('resolves the legacy non-phase CrossRef form (<file-slug>#<anchor>) unchanged', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: `---
title: 't'
---
import { CrossRef } from '@synergy/spec-kit';

# Title

## Summary

See <CrossRef to="01-architecture#section-blueprint" />.

## Goals

- One.
`,
      [`${SESSION_REL}/01-architecture.mdx`]: `# Architecture

## Section blueprint

Some content.
`,
    });
    const report = validate({ projectRoot: root });
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('warns on the legacy phase form (02-implementation#phase-N) when the anchor resolves', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: `---
title: 't'
---
import { CrossRef } from '@synergy/spec-kit';

# Title

## Summary

See <CrossRef to="02-implementation#phase-1" />.

## Goals

- One.
`,
      [`${SESSION_REL}/02-implementation.mdx`]: `# Implementation

## Phase 1

content.
`,
    });
    const report = validate({ projectRoot: root });
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    const warn = report.issues.find((i) => i.severity === 'warning' && /phase-1/.test(i.message));
    expect(warn).toBeDefined();
    expect(warn?.message).toMatch(/phases\//);
  });
});

describe('validate — required headings in 00-overview.mdx', () => {
  it('errors when Summary is missing', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: `---
title: 't'
---

# Title

## Goals

- A goal.
`,
    });
    const report = validate({ projectRoot: root });
    const summaryErr = report.issues.find(
      (i) => i.severity === 'error' && /summary/i.test(i.message),
    );
    expect(summaryErr).toBeDefined();
  });

  it('errors when Goals is missing', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: `---
title: 't'
---

# Title

## Summary

Some text.
`,
    });
    const report = validate({ projectRoot: root });
    const goalsErr = report.issues.find((i) => i.severity === 'error' && /goals/i.test(i.message));
    expect(goalsErr).toBeDefined();
  });

  it('does not warn or error on missing optional sections (tech stack, timeline, risks, etc.)', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: minimalOverview('Just the basics'),
    });
    const report = validate({ projectRoot: root });
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(report.issues.filter((i) => i.severity === 'warning')).toEqual([]);
  });

  it('does not check Summary/Goals on other files', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: minimalOverview('Has summary + goals'),
      [`${SESSION_REL}/01-architecture.mdx`]: `# Architecture

Some content with no summary or goals heading.
`,
    });
    const report = validate({ projectRoot: root });
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('validate — Phase id discipline', () => {
  it('warns when an inline <Phase> has no id', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: minimalOverview('phased'),
      [`${SESSION_REL}/02-implementation.mdx`]: `---
title: 'Impl'
---
import { Phase } from '@synergy/spec-kit';

# Impl

<Phase number={1} title="Storage" />
`,
    });
    const report = validate({ projectRoot: root });
    const warn = report.issues.find(
      (i) => i.severity === 'warning' && i.component === 'Phase' && /\bid\b/.test(i.message),
    );
    expect(warn).toBeDefined();
  });

  it('does not warn when <Phase> has an id', () => {
    const root = project({
      [`${SESSION_REL}/00-overview.mdx`]: minimalOverview('phased'),
      [`${SESSION_REL}/02-implementation.mdx`]: `---
title: 'Impl'
---
import { Phase } from '@synergy/spec-kit';

# Impl

<Phase id="storage" number={1} title="Storage" />
`,
    });
    const report = validate({ projectRoot: root });
    const warn = report.issues.find((i) => i.component === 'Phase' && /\bid\b/.test(i.message));
    expect(warn).toBeUndefined();
  });
});
