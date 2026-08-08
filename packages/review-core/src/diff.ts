import { TextDecoder, TextEncoder } from 'node:util';
import { hashText } from './hash.js';
import { findDuplicateReviewItemId } from './review-item-identity.js';
import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffReviewSnapshot,
  ReviewItem,
  ReviewRange,
  ReviewSource,
} from './types.js';

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const OCTAL_ESCAPE_PATTERN = /^[0-7]{3}$/u;
const PATH_ENCODER = new TextEncoder();
const C_STYLE_ESCAPE_BYTES = new Map<string, number>([
  ['a', 0x07],
  ['b', 0x08],
  ['f', 0x0c],
  ['n', 0x0a],
  ['r', 0x0d],
  ['t', 0x09],
  ['v', 0x0b],
  ['\\', 0x5c],
  ['"', 0x22],
]);

export interface BuildDiffSnapshotInput {
  revisionId: string;
  predecessorRevisionId?: string;
  source: ReviewSource;
  fingerprint: string;
  createdAt: string;
  patch: string;
}

interface MutableDiffFile extends DiffFile {
  previousPath: string | undefined;
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

function stripDiffPath(path: string): string {
  if (path === '/dev/null') return path;
  const stripped = path.replace(/^[ab]\//u, '');
  assertSafeRepositoryPath(stripped);
  return stripped;
}

function readQuotedPath(value: string, start: number): { path: string; next: number } | null {
  const bytes: number[] = [];
  let index = start + 1;
  while (index < value.length) {
    const character = value[index]!;
    if (character === '"') {
      try {
        return {
          path: new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)),
          next: index + 1,
        };
      } catch {
        return null;
      }
    }
    if (character !== '\\') {
      const codePoint = value.codePointAt(index);
      if (codePoint === undefined) return null;
      const literal = String.fromCodePoint(codePoint);
      bytes.push(...PATH_ENCODER.encode(literal));
      index += literal.length;
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === undefined) return null;
    const octal = value.slice(index + 1, index + 4);
    if (OCTAL_ESCAPE_PATTERN.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 4;
      continue;
    }
    const escapedByte = C_STYLE_ESCAPE_BYTES.get(escaped);
    if (escapedByte === undefined) return null;
    bytes.push(escapedByte);
    index += 2;
  }
  return null;
}

function readDiffHeaderPaths(value: string): string[] | null {
  const paths: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (value[index] === ' ') index += 1;
    if (index === value.length) break;

    if (value[index] === '"') {
      const quoted = readQuotedPath(value, index);
      if (!quoted) return null;
      paths.push(quoted.path);
      index = quoted.next;
      continue;
    }

    const nextSpace = value.indexOf(' ', index);
    if (nextSpace === -1) {
      paths.push(value.slice(index));
      break;
    }
    paths.push(value.slice(index, nextSpace));
    index = nextSpace + 1;
  }
  return paths;
}

function readPatchPath(value: string): string {
  const pathWithMetadata = value.split('\t', 1)[0]!;
  if (!pathWithMetadata.startsWith('"')) return pathWithMetadata;
  const quoted = readQuotedPath(pathWithMetadata, 0);
  if (!quoted || quoted.next !== pathWithMetadata.length) {
    throw new Error(`invalid quoted diff path: ${value}`);
  }
  return quoted.path;
}

function parseGitHeaderPaths(line: string): { oldPath: string; newPath: string } {
  const paths = readDiffHeaderPaths(line.slice('diff --git '.length));
  if (!paths || paths.length !== 2) throw new Error(`invalid diff header: ${line}`);

  return { oldPath: stripDiffPath(paths[0]!), newPath: stripDiffPath(paths[1]!) };
}

function createDiffFile(oldPath: string, newPath: string): MutableDiffFile {
  return {
    path: newPath,
    previousPath: oldPath === newPath ? undefined : oldPath,
    status: 'modified',
    additions: 0,
    deletions: 0,
    binary: false,
    hunks: [],
  };
}

function parseHunk(line: string): DiffHunk | null {
  const match = HUNK_HEADER_PATTERN.exec(line);
  if (!match) return null;

  return {
    header: line,
    oldStart: Number.parseInt(match[1]!, 10),
    oldLines: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3]!, 10),
    newLines: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
    lines: [],
  };
}

function appendHunkLine(
  hunk: DiffHunk,
  line: string,
  oldLine: number,
  newLine: number,
): { oldLine: number; newLine: number; addition: boolean; deletion: boolean } | null {
  let diffLine: DiffLine;
  if (line.startsWith('+')) {
    diffLine = { kind: 'add', text: line.slice(1), oldLine: null, newLine };
    hunk.lines.push(diffLine);
    return { oldLine, newLine: newLine + 1, addition: true, deletion: false };
  }
  if (line.startsWith('-')) {
    diffLine = { kind: 'remove', text: line.slice(1), oldLine, newLine: null };
    hunk.lines.push(diffLine);
    return { oldLine: oldLine + 1, newLine, addition: false, deletion: true };
  }
  if (line.startsWith(' ')) {
    diffLine = { kind: 'context', text: line.slice(1), oldLine, newLine };
    hunk.lines.push(diffLine);
    return { oldLine: oldLine + 1, newLine: newLine + 1, addition: false, deletion: false };
  }
  return null;
}

/** Parses a Git unified patch into repository-relative file and line state. */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: MutableDiffFile[] = [];
  const patchLinesByFile = new Map<MutableDiffFile, string[]>();
  let currentFile: MutableDiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  // Unified hunks declare their exact row budget in the header. Consuming rows
  // beyond it would capture surrounding non-diff text (e.g. format-patch commit
  // prose and "-- " signatures between commits) as diff lines.
  let remainingOld = 0;
  let remainingNew = 0;

  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const { oldPath, newPath } = parseGitHeaderPaths(line);
      currentFile = createDiffFile(oldPath, newPath);
      files.push(currentFile);
      patchLinesByFile.set(currentFile, [line]);
      currentHunk = null;
      continue;
    }

    if (!currentFile) continue;
    patchLinesByFile.get(currentFile)!.push(line);

    if (line.startsWith('new file mode ')) {
      currentFile.status = 'added';
      currentFile.newMode = line.slice('new file mode '.length);
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      currentFile.status = 'deleted';
      currentFile.oldMode = line.slice('deleted file mode '.length);
      continue;
    }
    if (line.startsWith('old mode ')) {
      currentFile.oldMode = line.slice('old mode '.length);
      continue;
    }
    if (line.startsWith('new mode ')) {
      currentFile.newMode = line.slice('new mode '.length);
      continue;
    }
    if (line.startsWith('rename from ')) {
      const previousPath = stripDiffPath(`a/${readPatchPath(line.slice('rename from '.length))}`);
      currentFile.previousPath = previousPath;
      currentFile.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      currentFile.path = stripDiffPath(`b/${readPatchPath(line.slice('rename to '.length))}`);
      currentFile.status = 'renamed';
      continue;
    }
    if (line.startsWith('copy from ')) {
      currentFile.previousPath = stripDiffPath(
        `a/${readPatchPath(line.slice('copy from '.length))}`,
      );
      currentFile.status = 'copied';
      continue;
    }
    if (line.startsWith('copy to ')) {
      currentFile.path = stripDiffPath(`b/${readPatchPath(line.slice('copy to '.length))}`);
      currentFile.status = 'copied';
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      currentFile.binary = true;
      currentFile.status = 'binary';
      currentHunk = null;
      continue;
    }
    if (line.startsWith('--- ')) {
      const oldPath = stripDiffPath(readPatchPath(line.slice(4)));
      if (oldPath === '/dev/null') {
        currentFile.status = 'added';
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const newPath = stripDiffPath(readPatchPath(line.slice(4)));
      if (newPath === '/dev/null') {
        currentFile.status = 'deleted';
      }
      continue;
    }

    const hunk = parseHunk(line);
    if (hunk) {
      currentFile.hunks.push(hunk);
      currentHunk = hunk;
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      remainingOld = hunk.oldLines;
      remainingNew = hunk.newLines;
      continue;
    }
    if (!currentHunk) continue;

    if (line === '\\ No newline at end of file') {
      const previousLine = currentHunk.lines.at(-1);
      if (previousLine) previousLine.noNewlineAtEnd = true;
      continue;
    }

    if (remainingOld <= 0 && remainingNew <= 0) continue;

    const next = appendHunkLine(currentHunk, line, oldLine, newLine);
    if (!next) continue;
    oldLine = next.oldLine;
    newLine = next.newLine;
    if (next.addition) {
      currentFile.additions += 1;
      remainingNew -= 1;
    } else if (next.deletion) {
      currentFile.deletions += 1;
      remainingOld -= 1;
    } else {
      remainingOld -= 1;
      remainingNew -= 1;
    }
  }

  for (const file of files) {
    if (file.binary) file.binaryPatchHash = hashText(patchLinesByFile.get(file)!.join('\n'));
  }
  return files;
}

function canonicalDiffLine(line: DiffLine): string {
  const newlineMarker = line.noNewlineAtEnd ? '\n\\ No newline at end of file' : '';
  return `${line.kind}:${line.text}${newlineMarker}`;
}

export function createHunkReviewItem(path: string, hunk: DiffHunk): ReviewItem {
  const selected = hunk.lines
    .filter((line) => line.kind !== 'context')
    .map(canonicalDiffLine)
    .join('\n');
  const context = hunk.lines.map(canonicalDiffLine).join('\n');
  const rangeStart = Math.max(1, hunk.newStart);
  const range: ReviewRange = {
    start: rangeStart,
    end: hunk.newLines === 0 ? rangeStart : rangeStart + hunk.newLines - 1,
  };
  return {
    id: `hunk-${hashText(`${path}\n${context}`).slice(0, 16)}`,
    kind: 'hunk',
    path,
    label: hunk.header,
    range,
    contentHash: hashText(selected),
    locationHash: hashText(`${path}\n${context}`),
  };
}

function fileReviewLabel(file: DiffFile): string {
  if (file.binary) return 'Binary file changed';
  if (file.status === 'renamed') return 'File renamed';
  if (file.status === 'copied') return 'File copied';
  if (file.status === 'added') return 'Empty file added';
  if (file.status === 'deleted') return 'Empty file deleted';
  if (file.oldMode || file.newMode) return 'File mode changed';
  return 'File metadata changed';
}

export function createFileReviewItem(file: DiffFile): ReviewItem {
  const content = [
    file.status,
    file.previousPath ?? '',
    file.oldMode ?? '',
    file.newMode ?? '',
    file.binaryPatchHash ?? '',
  ].join('\n');
  const location = `${file.path}\n${file.previousPath ?? ''}`;
  const contentHash = hashText(content);
  const locationHash = hashText(location);
  return {
    id: `file-${hashText(`${location}\n${content}`).slice(0, 16)}`,
    kind: 'file',
    path: file.path,
    label: fileReviewLabel(file),
    range: { start: 1, end: 1 },
    contentHash,
    locationHash,
  };
}

export function buildDiffSnapshot(input: BuildDiffSnapshotInput): DiffReviewSnapshot {
  const files = parseUnifiedDiff(input.patch);
  // Item resolution addresses files by path, so a patch that lists the same
  // path twice (a per-commit format-patch stream rather than one combined
  // diff) can never produce a coherent snapshot.
  const seenPaths = new Set<string>();
  for (const file of files) {
    if (seenPaths.has(file.path)) {
      throw new Error(
        `duplicate diff entry for ${file.path}: capture must supply one combined diff per source, not per-commit patches`,
      );
    }
    seenPaths.add(file.path);
  }
  const entries = files.flatMap((file) =>
    file.hunks.map((hunk) => ({ file, hunk, item: createHunkReviewItem(file.path, hunk) })),
  );
  const semanticIdCounts = new Map<string, number>();
  for (const { item } of entries) {
    semanticIdCounts.set(item.id, (semanticIdCounts.get(item.id) ?? 0) + 1);
  }
  const capturedRangeOccurrences = new Map<string, number>();
  const items = entries.map(({ file, hunk, item: semanticItem }) => {
    let item = semanticItem;
    if ((semanticIdCounts.get(semanticItem.id) ?? 0) > 1) {
      const capturedRange = `${hunk.oldStart}:${hunk.oldLines}:${hunk.newStart}:${hunk.newLines}`;
      const occurrenceKey = `${semanticItem.id}\n${capturedRange}`;
      const occurrence = (capturedRangeOccurrences.get(occurrenceKey) ?? 0) + 1;
      capturedRangeOccurrences.set(occurrenceKey, occurrence);
      const rangeDiscriminator = hashText(`${file.path}\n${capturedRange}\n${occurrence}`).slice(
        0,
        16,
      );
      item = { ...semanticItem, id: `${semanticItem.id}-${rangeDiscriminator}` };
    }
    hunk.reviewItemId = item.id;
    hunk.reviewItemContentHash = item.contentHash;
    hunk.reviewItemLocationHash = item.locationHash;
    return item;
  });
  for (const file of files) {
    if (file.hunks.length > 0) continue;
    const item = createFileReviewItem(file);
    file.reviewItemId = item.id;
    file.reviewItemContentHash = item.contentHash;
    file.reviewItemLocationHash = item.locationHash;
    items.push(item);
  }
  const duplicateItemId = findDuplicateReviewItemId(items);
  if (duplicateItemId) throw new Error(`duplicate diff review item id: ${duplicateItemId}`);
  return {
    schemaVersion: 1,
    revisionId: input.revisionId,
    ...(input.predecessorRevisionId === undefined
      ? {}
      : { predecessorRevisionId: input.predecessorRevisionId }),
    source: input.source,
    fingerprint: input.fingerprint,
    createdAt: input.createdAt,
    kind: 'diff',
    files,
    items,
  };
}
