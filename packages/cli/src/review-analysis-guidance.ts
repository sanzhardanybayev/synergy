import type { ReviewSnapshot } from '@synergy/review-core';

export interface ReviewAnalysisGuidance {
  textFiles: number;
  textLines: number;
  minimumSections: number;
  targetSections: number;
  maximumSections: number;
  scopeTooBroad: boolean;
}

function capturedTextCounts(snapshot: ReviewSnapshot): { textFiles: number; textLines: number } {
  if (snapshot.kind === 'scope') {
    const textFiles = snapshot.files.filter((file) => !file.binary);
    return {
      textFiles: textFiles.length,
      textLines: textFiles.reduce((total, file) => total + file.lines.length, 0),
    };
  }

  const textFiles = snapshot.files.filter((file) => !file.binary);
  return {
    textFiles: textFiles.length,
    textLines: textFiles.reduce(
      (total, file) =>
        total + file.hunks.reduce((fileTotal, hunk) => fileTotal + hunk.lines.length, 0),
      0,
    ),
  };
}

function boundedSectionCount(
  textFiles: number,
  textLines: number,
  linesPerSection: number,
): number {
  return Math.max(textFiles, Math.min(30, Math.ceil(textLines / linesPerSection)));
}

export function deriveReviewAnalysisGuidance(snapshot: ReviewSnapshot): ReviewAnalysisGuidance {
  const { textFiles, textLines } = capturedTextCounts(snapshot);
  return {
    textFiles,
    textLines,
    minimumSections: boundedSectionCount(textFiles, textLines, 150),
    targetSections: boundedSectionCount(textFiles, textLines, 120),
    maximumSections: boundedSectionCount(textFiles, textLines, 100),
    scopeTooBroad: textFiles > 30 || textLines > 4_500,
  };
}
