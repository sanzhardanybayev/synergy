import { hashText } from './hash.js';
import { findDuplicateReviewItemId } from './review-item-identity.js';
import type { ReviewItem, ReviewSource, ScopeReviewSnapshot, SourceFile } from './types.js';

const CONTEXT_RADIUS = 2;

export interface BuildScopeSnapshotInput {
  revisionId: string;
  predecessorRevisionId?: string;
  source: ReviewSource;
  fingerprint: string;
  createdAt: string;
  files: SourceFile[];
}

export interface ProposedCodeSection {
  path: string;
  label: string;
  start: number;
  end: number;
  parentLabel?: string;
}

function assertSafeRepositoryPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    path.split(/[\\/]/u).some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`invalid repository-relative path: ${path}`);
  }
}

function assertUniqueFiles(files: SourceFile[]): void {
  const paths = new Set<string>();
  for (const file of files) {
    assertSafeRepositoryPath(file.path);
    if (paths.has(file.path)) throw new Error(`duplicate source file: ${file.path}`);
    paths.add(file.path);
  }
}

function findSectionLines(file: SourceFile, section: ProposedCodeSection): SourceFile['lines'] {
  const startIndex = file.lines.findIndex((line) => line.number === section.start);
  const endIndex = file.lines.findIndex((line) => line.number === section.end);
  if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
    throw new Error(`section range is outside ${section.path}`);
  }
  return file.lines.slice(startIndex, endIndex + 1);
}

function validateAndBuildSection(
  snapshot: ScopeReviewSnapshot,
  section: ProposedCodeSection,
): ReviewItem {
  assertSafeRepositoryPath(section.path);
  if (section.label.trim().length === 0) throw new Error('section label cannot be empty');
  if (
    !Number.isInteger(section.start) ||
    !Number.isInteger(section.end) ||
    section.start > section.end
  ) {
    throw new Error('section range must select at least one line');
  }

  const file = snapshot.files.find((candidate) => candidate.path === section.path);
  if (!file) throw new Error(`section path does not exist: ${section.path}`);
  if (file.binary) throw new Error(`cannot create a section for binary file: ${section.path}`);

  const selectedLines = findSectionLines(file, section);
  if (selectedLines.length === 0) throw new Error('section range must select at least one line');
  const startIndex = file.lines.indexOf(selectedLines[0]!);
  const endIndex = startIndex + selectedLines.length;
  const surrounding = file.lines
    .slice(
      Math.max(0, startIndex - CONTEXT_RADIUS),
      Math.min(file.lines.length, endIndex + CONTEXT_RADIUS),
    )
    .filter((line) => line.number < section.start || line.number > section.end)
    .map((line) => line.text)
    .join('\n');
  const parentLabel = section.parentLabel ?? '';
  const content = selectedLines.map((line) => line.text).join('\n');
  const location = `${section.path}\n${section.label}\n${parentLabel}\n${surrounding}`;
  const locationHash = hashText(location);

  return {
    id: `code-section-${locationHash.slice(0, 16)}`,
    kind: 'code-section',
    path: section.path,
    label: section.label,
    range: { start: section.start, end: section.end },
    contentHash: hashText(content),
    locationHash,
  };
}

function assertNoOverlaps(sections: ProposedCodeSection[]): void {
  const byPath = new Map<string, ProposedCodeSection[]>();
  for (const section of sections) {
    const fileSections = byPath.get(section.path) ?? [];
    fileSections.push(section);
    byPath.set(section.path, fileSections);
  }
  for (const [path, pathSections] of byPath) {
    const sorted = [...pathSections].sort(
      (left, right) => left.start - right.start || left.end - right.end,
    );
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index]!.start <= sorted[index - 1]!.end) {
        throw new Error(`overlapping code sections in ${path}`);
      }
    }
  }
}

export function buildScopeSnapshot(input: BuildScopeSnapshotInput): ScopeReviewSnapshot {
  assertUniqueFiles(input.files);
  return {
    schemaVersion: 1,
    revisionId: input.revisionId,
    ...(input.predecessorRevisionId === undefined
      ? {}
      : { predecessorRevisionId: input.predecessorRevisionId }),
    source: input.source,
    fingerprint: input.fingerprint,
    createdAt: input.createdAt,
    kind: 'scope',
    files: input.files,
    items: [],
  };
}

export function applyCodeSections(
  snapshot: ScopeReviewSnapshot,
  proposed: ProposedCodeSection[],
): ScopeReviewSnapshot {
  assertNoOverlaps(proposed);
  const items = proposed.map((section) => validateAndBuildSection(snapshot, section));
  const duplicateItemId = findDuplicateReviewItemId(items);
  if (duplicateItemId) {
    throw new Error(
      `duplicate code-section identity ${duplicateItemId}; use a distinct label or parentLabel`,
    );
  }
  return { ...snapshot, items };
}
