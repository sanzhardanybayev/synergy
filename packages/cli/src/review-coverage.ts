import type { ScopeReviewSnapshot } from '@synergy/review-core';

export interface ScopeSectionRange {
  key: string;
  path: string;
  start: number;
  end: number;
}

function formatRange(section: ScopeSectionRange): string {
  return `${section.path}:${section.start}-${section.end} (key ${JSON.stringify(section.key)})`;
}

export function assertCompleteScopeCoverage(
  snapshot: ScopeReviewSnapshot,
  sections: readonly ScopeSectionRange[],
): void {
  const filesByPath = new Map(
    snapshot.files.map((file) => [
      file.path,
      { file, capturedLineNumbers: new Set(file.lines.map((line) => line.number)) },
    ]),
  );
  const sectionsByPath = new Map<string, ScopeSectionRange[]>();
  const sectionsByKey = new Map<string, ScopeSectionRange>();

  for (const section of sections) {
    const duplicate = sectionsByKey.get(section.key);
    if (duplicate) {
      throw new Error(
        `duplicate scope section key ${JSON.stringify(section.key)} at ${formatRange(section)}; first declared at ${duplicate.path}:${duplicate.start}-${duplicate.end}`,
      );
    }
    sectionsByKey.set(section.key, section);

    const capturedFile = filesByPath.get(section.path);
    if (!capturedFile) {
      throw new Error(`scope range ${formatRange(section)} targets a path that was not captured`);
    }
    const { file, capturedLineNumbers } = capturedFile;
    if (file.binary) {
      throw new Error(`scope range ${formatRange(section)} targets a binary file`);
    }
    if (!Number.isInteger(section.start) || !Number.isInteger(section.end)) {
      throw new Error(`scope range ${formatRange(section)} must use integer captured line numbers`);
    }
    if (section.start > section.end) {
      throw new Error(`scope range ${formatRange(section)} is a reversed range`);
    }

    const missingEndpoint = !capturedLineNumbers.has(section.start)
      ? section.start
      : !capturedLineNumbers.has(section.end)
        ? section.end
        : undefined;
    if (missingEndpoint !== undefined) {
      throw new Error(
        `scope range ${formatRange(section)} includes ${section.path}:${missingEndpoint}, which is not a captured line`,
      );
    }

    const fileSections = sectionsByPath.get(section.path) ?? [];
    fileSections.push(section);
    sectionsByPath.set(section.path, fileSections);
  }

  for (const file of snapshot.files) {
    if (file.binary || file.lines.length === 0) continue;
    const fileSections = sectionsByPath.get(file.path) ?? [];
    const firstLine = file.lines[0]!.number;
    const lastLine = file.lines[file.lines.length - 1]!.number;
    if (fileSections.length === 0) {
      throw new Error(
        `incomplete scope coverage for ${file.path}: no sections cover captured lines ${firstLine}-${lastLine}`,
      );
    }

    const sorted = [...fileSections].sort(
      (left, right) => left.start - right.start || left.end - right.end,
    );
    let expectedLine = firstLine;
    for (const section of sorted) {
      if (section.start !== expectedLine) {
        const problem = section.start < expectedLine ? 'overlap' : 'gap';
        throw new Error(
          `incomplete scope coverage for ${file.path}: expected line ${expectedLine}; first offending range ${section.start}-${section.end} (key ${JSON.stringify(section.key)}) creates an ${problem}`,
        );
      }
      expectedLine = section.end + 1;
    }

    if (expectedLine !== lastLine + 1) {
      const finalSection = sorted[sorted.length - 1]!;
      throw new Error(
        `incomplete scope coverage for ${file.path}: expected coverage through line ${lastLine}; final offending range ${finalSection.start}-${finalSection.end} (key ${JSON.stringify(finalSection.key)}) leaves a trailing gap`,
      );
    }
  }
}
