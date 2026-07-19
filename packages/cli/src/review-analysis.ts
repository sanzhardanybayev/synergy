import type { ReviewGroup, ReviewInsightConfidence, ReviewItemInsight } from '@synergy/review-core';

export interface ScopeAnalysisSectionInput {
  key: string;
  path: string;
  label: string;
  parentLabel?: string;
  start: number;
  end: number;
  description: string;
  confidence: ReviewInsightConfidence;
  evidencePaths: string[];
}

export interface ScopeAnalysisGroupInput {
  id: string;
  label: string;
  sectionKeys: string[];
}

export type ReviewAnalysisInput =
  | {
      kind: 'scope';
      groups: ScopeAnalysisGroupInput[];
      sections: ScopeAnalysisSectionInput[];
    }
  | { kind: 'diff'; groups: ReviewGroup[]; items: ReviewItemInsight[] };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const GROUP_ID = /^[a-z0-9][a-z0-9_-]*$/u;
const MAX_DESCRIPTION_LENGTH = 600;

function propertyPath(path: string, key: string): string {
  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function fail(path: string, expectation: string): never {
  throw new Error(`${path} ${expectation}`);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(propertyPath(path, key), 'is not allowed');
  }
}

function assertArray(value: unknown, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
}

function assertNonEmptyArray(value: unknown, path: string): asserts value is unknown[] {
  assertArray(value, path);
  if (value.length === 0) fail(path, 'must not be empty');
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(path, 'must be a non-empty string');
  }
}

function assertGroupId(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (!GROUP_ID.test(value)) {
    fail(path, 'must match ^[a-z0-9][a-z0-9_-]*$');
  }
}

function assertDescription(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (Array.from(value).length > MAX_DESCRIPTION_LENGTH) {
    fail(path, `must contain at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
}

function assertInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail(path, 'must be a positive integer');
  }
}

function parseConfidence(value: unknown, path: string): ReviewInsightConfidence {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return fail(path, 'must be one of "high", "medium", or "low"');
}

function parseStringArray(value: unknown, path: string): string[] {
  assertNonEmptyArray(value, path);
  const result = value.map((entry, index) => {
    assertString(entry, `${path}[${index}]`);
    return entry;
  });
  assertUniqueValues(result, path);
  return result;
}

function assertUniqueValues(values: readonly string[], path: string): void {
  const indexes = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    const firstIndex = indexes.get(value);
    if (firstIndex !== undefined) {
      fail(`${path}[${index}]`, `duplicates ${path}[${firstIndex}]`);
    }
    indexes.set(value, index);
  }
}

function assertUniqueProperty<T>(
  values: readonly T[],
  path: string,
  property: string,
  select: (value: T) => string,
): void {
  const indexes = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    const selected = select(value);
    const firstIndex = indexes.get(selected);
    if (firstIndex !== undefined) {
      fail(
        propertyPath(`${path}[${index}]`, property),
        `duplicates ${propertyPath(`${path}[${firstIndex}]`, property)}`,
      );
    }
    indexes.set(selected, index);
  }
}

function parseDiffGroup(value: unknown, index: number): ReviewGroup {
  const path = `$.groups[${index}]`;
  assertRecord(value, path);
  assertOnlyKeys(value, ['id', 'label', 'reviewItemIds'], path);
  assertGroupId(value.id, `${path}.id`);
  assertString(value.label, `${path}.label`);
  return {
    id: value.id,
    label: value.label,
    reviewItemIds: parseStringArray(value.reviewItemIds, `${path}.reviewItemIds`),
  };
}

function parseDiffItem(value: unknown, index: number): ReviewItemInsight {
  const path = `$.items[${index}]`;
  assertRecord(value, path);
  assertOnlyKeys(value, ['reviewItemId', 'description', 'confidence', 'evidencePaths'], path);
  assertString(value.reviewItemId, `${path}.reviewItemId`);
  assertDescription(value.description, `${path}.description`);
  return {
    reviewItemId: value.reviewItemId,
    description: value.description,
    confidence: parseConfidence(value.confidence, `${path}.confidence`),
    evidencePaths: parseStringArray(value.evidencePaths, `${path}.evidencePaths`),
  };
}

function parseScopeGroup(value: unknown, index: number): ScopeAnalysisGroupInput {
  const path = `$.groups[${index}]`;
  assertRecord(value, path);
  assertOnlyKeys(value, ['id', 'label', 'sectionKeys'], path);
  assertGroupId(value.id, `${path}.id`);
  assertString(value.label, `${path}.label`);
  return {
    id: value.id,
    label: value.label,
    sectionKeys: parseStringArray(value.sectionKeys, `${path}.sectionKeys`),
  };
}

function parseScopeSection(value: unknown, index: number): ScopeAnalysisSectionInput {
  const path = `$.sections[${index}]`;
  assertRecord(value, path);
  assertOnlyKeys(
    value,
    [
      'key',
      'path',
      'label',
      'parentLabel',
      'start',
      'end',
      'description',
      'confidence',
      'evidencePaths',
    ],
    path,
  );
  assertString(value.key, `${path}.key`);
  assertString(value.path, `${path}.path`);
  assertString(value.label, `${path}.label`);
  if (value.parentLabel !== undefined) {
    assertString(value.parentLabel, `${path}.parentLabel`);
  }
  assertInteger(value.start, `${path}.start`);
  assertInteger(value.end, `${path}.end`);
  assertDescription(value.description, `${path}.description`);
  return {
    key: value.key,
    path: value.path,
    label: value.label,
    ...(value.parentLabel === undefined ? {} : { parentLabel: value.parentLabel }),
    start: value.start,
    end: value.end,
    description: value.description,
    confidence: parseConfidence(value.confidence, `${path}.confidence`),
    evidencePaths: parseStringArray(value.evidencePaths, `${path}.evidencePaths`),
  };
}

function parseGroups<T extends { id: string }>(
  value: unknown,
  parseGroup: (entry: unknown, index: number) => T,
): T[] {
  assertNonEmptyArray(value, '$.groups');
  const groups = value.map(parseGroup);
  assertUniqueProperty(groups, '$.groups', 'id', (group) => group.id);
  return groups;
}

function assertEveryReferenceIsOwned(
  definitions: readonly string[],
  definitionPath: (index: number) => string,
  references: readonly (readonly string[])[],
  referencePath: (groupIndex: number, referenceIndex: number) => string,
): void {
  const definitionIndexes = new Map(definitions.map((key, index) => [key, index]));
  const owners = new Map<string, string>();
  for (const [groupIndex, groupReferences] of references.entries()) {
    for (const [referenceIndex, reference] of groupReferences.entries()) {
      const path = referencePath(groupIndex, referenceIndex);
      if (!definitionIndexes.has(reference)) fail(path, 'references an unknown item');
      const firstPath = owners.get(reference);
      if (firstPath !== undefined) fail(path, `duplicates ${firstPath}`);
      owners.set(reference, path);
    }
  }
  for (const [index, key] of definitions.entries()) {
    if (!owners.has(key)) fail(definitionPath(index), 'is not referenced by any group');
  }
}

function parseDiffAnalysis(value: Record<string, unknown>): ReviewAnalysisInput {
  assertOnlyKeys(value, ['groups', 'items'], '$');
  const groups = parseGroups(value.groups, parseDiffGroup);
  assertNonEmptyArray(value.items, '$.items');
  const items = value.items.map(parseDiffItem);
  assertUniqueProperty(items, '$.items', 'reviewItemId', (item) => item.reviewItemId);
  assertEveryReferenceIsOwned(
    items.map((item) => item.reviewItemId),
    (index) => `$.items[${index}].reviewItemId`,
    groups.map((group) => group.reviewItemIds),
    (groupIndex, referenceIndex) => `$.groups[${groupIndex}].reviewItemIds[${referenceIndex}]`,
  );
  return { kind: 'diff', groups, items };
}

function parseScopeAnalysis(value: Record<string, unknown>): ReviewAnalysisInput {
  assertOnlyKeys(value, ['groups', 'sections'], '$');
  const groups = parseGroups(value.groups, parseScopeGroup);
  assertNonEmptyArray(value.sections, '$.sections');
  const sections = value.sections.map(parseScopeSection);
  assertUniqueProperty(sections, '$.sections', 'key', (section) => section.key);
  assertEveryReferenceIsOwned(
    sections.map((section) => section.key),
    (index) => `$.sections[${index}].key`,
    groups.map((group) => group.sectionKeys),
    (groupIndex, referenceIndex) => `$.groups[${groupIndex}].sectionKeys[${referenceIndex}]`,
  );
  return { kind: 'scope', groups, sections };
}

export function parseReviewAnalysisInput(value: unknown): ReviewAnalysisInput {
  assertRecord(value, '$');
  assertOnlyKeys(value, ['groups', 'items', 'sections'], '$');
  const hasItems = Object.hasOwn(value, 'items');
  const hasSections = Object.hasOwn(value, 'sections');
  if (hasItems && hasSections) {
    fail('$.items', 'is not allowed when $.sections is present');
  }
  if (!hasItems && !hasSections) {
    fail('$', 'must contain exactly one of $.items or $.sections');
  }
  return hasItems ? parseDiffAnalysis(value) : parseScopeAnalysis(value);
}
