import type {
  RemovalRationale,
  RemovalReason,
  RemovalRunRef,
  ReviewGroup,
  ReviewInsightConfidence,
  ReviewItemInsight,
} from '@synergy/review-core';

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
  intro?: string;
}

export interface FileAnalysisInput {
  path: string;
  description: string;
  confidence: ReviewInsightConfidence;
}

export type ReviewAnalysisInput =
  | {
      kind: 'scope';
      groups: ScopeAnalysisGroupInput[];
      sections: ScopeAnalysisSectionInput[];
      files?: FileAnalysisInput[];
      summary?: string;
    }
  | {
      kind: 'diff';
      groups: ReviewGroup[];
      items: ReviewItemInsight[];
      removals?: RemovalRationale[];
      files?: FileAnalysisInput[];
      summary?: string;
    };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const GROUP_ID = /^[a-z0-9][a-z0-9_-]*$/u;
/**
 * Kept in lockstep with `$defs.fileInsight.properties.description.maxLength` in
 * review-analysis.schema.json - see the agreement test in review-analysis.test.ts.
 */
export const MAX_DESCRIPTION_LENGTH = 600;
/**
 * Kept in lockstep with `$defs.fileInsight.required` in review-analysis.schema.json - see the
 * agreement test in review-analysis.test.ts.
 */
export const FILE_INSIGHT_KEYS = ['path', 'description', 'confidence'] as const;
/**
 * Kept in lockstep with `$defs.diffAnalysis.properties.summary.maxLength` and
 * `$defs.scopeAnalysis.properties.summary.maxLength` in review-analysis.schema.json.
 */
export const MAX_SUMMARY_LENGTH = 600;
/**
 * Kept in lockstep with `$defs.diffGroup.properties.intro.maxLength` and
 * `$defs.scopeGroup.properties.intro.maxLength` in review-analysis.schema.json.
 */
export const MAX_INTRO_LENGTH = 300;

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

function assertBoundedText(value: unknown, path: string, max: number): asserts value is string {
  assertString(value, path);
  if (Array.from(value).length > max) {
    fail(path, `must contain at most ${max} characters`);
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
  assertOnlyKeys(value, ['id', 'label', 'reviewItemIds', 'intro'], path);
  assertGroupId(value.id, `${path}.id`);
  assertString(value.label, `${path}.label`);
  if (value.intro !== undefined) assertBoundedText(value.intro, `${path}.intro`, MAX_INTRO_LENGTH);
  return {
    id: value.id,
    label: value.label,
    reviewItemIds: parseStringArray(value.reviewItemIds, `${path}.reviewItemIds`),
    ...(value.intro === undefined ? {} : { intro: value.intro }),
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
  assertOnlyKeys(value, ['id', 'label', 'sectionKeys', 'intro'], path);
  assertGroupId(value.id, `${path}.id`);
  assertString(value.label, `${path}.label`);
  if (value.intro !== undefined) assertBoundedText(value.intro, `${path}.intro`, MAX_INTRO_LENGTH);
  return {
    id: value.id,
    label: value.label,
    sectionKeys: parseStringArray(value.sectionKeys, `${path}.sectionKeys`),
    ...(value.intro === undefined ? {} : { intro: value.intro }),
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

function parseFile(value: unknown, index: number): FileAnalysisInput {
  const path = `$.files[${index}]`;
  assertRecord(value, path);
  assertOnlyKeys(value, FILE_INSIGHT_KEYS, path);
  assertString(value.path, `${path}.path`);
  assertDescription(value.description, `${path}.description`);
  return {
    path: value.path,
    description: value.description,
    confidence: parseConfidence(value.confidence, `${path}.confidence`),
  };
}

function parseFiles(value: unknown): FileAnalysisInput[] {
  assertNonEmptyArray(value, '$.files');
  const files = value.map(parseFile);
  assertUniqueProperty(files, '$.files', 'path', (file) => file.path);
  return files;
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

const REMOVAL_REASONS = new Set<RemovalReason>([
  'moved',
  'merged',
  'replaced',
  'dead-code',
  'obsolete',
  'extracted-to-dep',
  'unclear',
]);

function parseRemovalRunRef(value: unknown, path: string): RemovalRunRef {
  assertRecord(value, path);
  assertOnlyKeys(value, ['path', 'start', 'end'], path);
  assertString(value.path, `${path}.path`);
  assertInteger(value.start, `${path}.start`);
  assertInteger(value.end, `${path}.end`);
  return { path: value.path, start: value.start, end: value.end };
}

function parseRemovalRationale(value: unknown, index: number): RemovalRationale {
  const path = `$.removals[${index}]`;
  assertRecord(value, path);
  assertOnlyKeys(value, ['reviewItemId', 'run', 'reason', 'description', 'movedTo'], path);
  assertString(value.reviewItemId, `${path}.reviewItemId`);
  assertDescription(value.description, `${path}.description`);
  if (typeof value.reason !== 'string' || !REMOVAL_REASONS.has(value.reason as RemovalReason)) {
    fail(`${path}.reason`, 'must be a known removal reason');
  }
  return {
    reviewItemId: value.reviewItemId,
    run: parseRemovalRunRef(value.run, `${path}.run`),
    reason: value.reason as RemovalReason,
    description: value.description,
    ...(value.movedTo === undefined
      ? {}
      : { movedTo: parseRemovalRunRef(value.movedTo, `${path}.movedTo`) }),
  };
}

function parseRemovals(value: unknown): RemovalRationale[] {
  assertNonEmptyArray(value, '$.removals');
  return value.map(parseRemovalRationale);
}

function parseDiffAnalysis(value: Record<string, unknown>): ReviewAnalysisInput {
  assertOnlyKeys(value, ['groups', 'items', 'removals', 'files', 'summary'], '$');
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
  const removals = value.removals === undefined ? undefined : parseRemovals(value.removals);
  const files = value.files === undefined ? undefined : parseFiles(value.files);
  if (value.summary !== undefined)
    assertBoundedText(value.summary, '$.summary', MAX_SUMMARY_LENGTH);
  return {
    kind: 'diff',
    groups,
    items,
    ...(removals ? { removals } : {}),
    ...(files ? { files } : {}),
    ...(value.summary === undefined ? {} : { summary: value.summary }),
  };
}

function parseScopeAnalysis(value: Record<string, unknown>): ReviewAnalysisInput {
  assertOnlyKeys(value, ['groups', 'sections', 'files', 'summary'], '$');
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
  const files = value.files === undefined ? undefined : parseFiles(value.files);
  if (value.summary !== undefined)
    assertBoundedText(value.summary, '$.summary', MAX_SUMMARY_LENGTH);
  return {
    kind: 'scope',
    groups,
    sections,
    ...(files ? { files } : {}),
    ...(value.summary === undefined ? {} : { summary: value.summary }),
  };
}

export function parseReviewAnalysisInput(value: unknown): ReviewAnalysisInput {
  assertRecord(value, '$');
  assertOnlyKeys(value, ['groups', 'items', 'sections', 'removals', 'files', 'summary'], '$');
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
