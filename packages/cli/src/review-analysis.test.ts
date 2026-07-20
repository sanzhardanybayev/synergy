import { describe, expect, it } from 'vitest';
import { parseReviewAnalysisInput } from './review-analysis.js';

const validDiffInput = {
  groups: [{ id: 'capture', label: 'Event capture', reviewItemIds: ['item-1'] }],
  items: [
    {
      reviewItemId: 'item-1',
      description: 'Explains the captured change in repository context.',
      confidence: 'high',
      evidencePaths: ['src/capture.ts'],
    },
  ],
};

const validScopeInput = {
  groups: [{ id: 'capture', label: 'Event capture', sectionKeys: ['capture-event'] }],
  sections: [
    {
      key: 'capture-event',
      path: 'src/capture.ts',
      label: 'Capture event',
      parentLabel: 'CaptureService',
      start: 10,
      end: 20,
      description: 'Records an event before dispatching its repository projection.',
      confidence: 'medium',
      evidencePaths: ['src/capture.ts', 'src/repository.ts'],
    },
  ],
};

describe('parseReviewAnalysisInput', () => {
  it('accepts the existing durable-item diff contract and constructs fresh values', () => {
    const parsed = parseReviewAnalysisInput(validDiffInput);

    expect(parsed).toEqual({ kind: 'diff', ...validDiffInput });
    expect(parsed).not.toBe(validDiffInput);
    expect(parsed.groups).not.toBe(validDiffInput.groups);
    if (parsed.kind !== 'diff') throw new Error('expected diff analysis');
    expect(parsed.items).not.toBe(validDiffInput.items);
  });

  it('accepts the local-key scope contract and constructs fresh values', () => {
    expect(parseReviewAnalysisInput(validScopeInput)).toEqual({
      kind: 'scope',
      ...validScopeInput,
    });
  });

  it.each([
    ['top level', { ...validDiffInput, extra: true }, '$.extra'],
    [
      'diff group',
      {
        ...validDiffInput,
        groups: [{ ...validDiffInput.groups[0], extra: true }],
      },
      '$.groups[0].extra',
    ],
    [
      'diff item',
      {
        ...validDiffInput,
        items: [{ ...validDiffInput.items[0], extra: true }],
      },
      '$.items[0].extra',
    ],
    [
      'scope group',
      {
        ...validScopeInput,
        groups: [{ ...validScopeInput.groups[0], extra: true }],
      },
      '$.groups[0].extra',
    ],
    [
      'scope section',
      {
        ...validScopeInput,
        sections: [{ ...validScopeInput.sections[0], extra: true }],
      },
      '$.sections[0].extra',
    ],
  ])('rejects an unknown key at the %s with its exact path', (_label, input, path) => {
    expect(() => parseReviewAnalysisInput(input)).toThrow(path);
  });

  it('rejects a mixed diff and scope contract', () => {
    expect(() =>
      parseReviewAnalysisInput({
        ...validScopeInput,
        items: validDiffInput.items,
      }),
    ).toThrow('$.items');
  });

  it('rejects duplicate scope section keys', () => {
    expect(() =>
      parseReviewAnalysisInput({
        ...validScopeInput,
        sections: [...validScopeInput.sections, { ...validScopeInput.sections[0] }],
      }),
    ).toThrow('$.sections[1].key');
  });

  it.each([
    ['diff', { ...validDiffInput, groups: [...validDiffInput.groups, validDiffInput.groups[0]] }],
    [
      'scope',
      { ...validScopeInput, groups: [...validScopeInput.groups, validScopeInput.groups[0]] },
    ],
  ])('rejects duplicate %s group IDs', (_kind, input) => {
    expect(() => parseReviewAnalysisInput(input)).toThrow('$.groups[1].id');
  });

  it('rejects a scope group reference to a missing section key', () => {
    expect(() =>
      parseReviewAnalysisInput({
        ...validScopeInput,
        groups: [{ ...validScopeInput.groups[0], sectionKeys: ['missing'] }],
      }),
    ).toThrow('$.groups[0].sectionKeys[0]');
  });

  it('rejects a section referenced more than once within one group', () => {
    expect(() =>
      parseReviewAnalysisInput({
        ...validScopeInput,
        groups: [
          {
            ...validScopeInput.groups[0],
            sectionKeys: ['capture-event', 'capture-event'],
          },
        ],
      }),
    ).toThrow('$.groups[0].sectionKeys[1]');
  });

  it('rejects a section referenced by multiple groups', () => {
    expect(() =>
      parseReviewAnalysisInput({
        ...validScopeInput,
        groups: [
          validScopeInput.groups[0],
          { id: 'duplicate-owner', label: 'Duplicate owner', sectionKeys: ['capture-event'] },
        ],
      }),
    ).toThrow('$.groups[1].sectionKeys[0]');
  });

  it('rejects an ungrouped section', () => {
    expect(() =>
      parseReviewAnalysisInput({
        ...validScopeInput,
        sections: [
          ...validScopeInput.sections,
          { ...validScopeInput.sections[0], key: 'unowned-section', start: 21, end: 30 },
        ],
      }),
    ).toThrow('$.sections[1].key');
  });

  it.each([
    [
      'diff description',
      { ...validDiffInput, items: [{ ...validDiffInput.items[0], description: '   ' }] },
      '$.items[0].description',
    ],
    [
      'scope description',
      {
        ...validScopeInput,
        sections: [{ ...validScopeInput.sections[0], description: '' }],
      },
      '$.sections[0].description',
    ],
    [
      'diff evidence',
      { ...validDiffInput, items: [{ ...validDiffInput.items[0], evidencePaths: [] }] },
      '$.items[0].evidencePaths',
    ],
    [
      'scope evidence',
      {
        ...validScopeInput,
        sections: [{ ...validScopeInput.sections[0], evidencePaths: [''] }],
      },
      '$.sections[0].evidencePaths[0]',
    ],
  ])('rejects empty %s at its exact path', (_label, input, path) => {
    expect(() => parseReviewAnalysisInput(input)).toThrow(path);
  });

  it.each([
    [
      'diff',
      { ...validDiffInput, items: [{ ...validDiffInput.items[0], confidence: 'certain' }] },
      '$.items[0].confidence',
    ],
    [
      'scope',
      {
        ...validScopeInput,
        sections: [{ ...validScopeInput.sections[0], confidence: 'certain' }],
      },
      '$.sections[0].confidence',
    ],
  ])('rejects invalid %s confidence at its exact path', (_label, input, path) => {
    expect(() => parseReviewAnalysisInput(input)).toThrow(path);
  });

  it.each([
    [
      'diff',
      { ...validDiffInput, groups: [{ ...validDiffInput.groups[0], id: 'Invalid ID' }] },
      '$.groups[0].id',
    ],
    [
      'scope',
      { ...validScopeInput, groups: [{ ...validScopeInput.groups[0], id: '-invalid' }] },
      '$.groups[0].id',
    ],
  ])('rejects an invalid %s group ID at its exact path', (_label, input, path) => {
    expect(() => parseReviewAnalysisInput(input)).toThrow(path);
  });

  it.each([
    [
      'diff',
      {
        ...validDiffInput,
        items: [{ ...validDiffInput.items[0], description: 'x'.repeat(601) }],
      },
      '$.items[0].description',
    ],
    [
      'scope',
      {
        ...validScopeInput,
        sections: [{ ...validScopeInput.sections[0], description: 'x'.repeat(601) }],
      },
      '$.sections[0].description',
    ],
  ])('rejects a 601-character %s description at its exact path', (_label, input, path) => {
    expect(() => parseReviewAnalysisInput(input)).toThrow(path);
  });
});
