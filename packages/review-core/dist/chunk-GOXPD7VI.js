// src/readiness.ts
function deriveReviewReadiness(bundle, analysisFinalized = true) {
  const states = bundle.snapshot.items.map((item) => bundle.progress.items[item.id]);
  const pending = states.filter((state) => !state || state.status === "needs-review").length;
  const stale = states.filter((state) => state?.status === "stale").length;
  const unanswered = bundle.questions.filter((question) => question.status !== "answered").length;
  return {
    ready: analysisFinalized && pending === 0 && stale === 0 && unanswered === 0 && !bundle.sourceChanged,
    preparing: !analysisFinalized,
    pending,
    stale,
    unanswered,
    sourceChanged: bundle.sourceChanged
  };
}

// src/review-row-id.ts
function reviewRowId(itemId, position) {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new Error("review row position must be a non-negative safe integer");
  }
  return `row-${encodeURIComponent(itemId)}-${position}`;
}

// src/browser-context.ts
function resolveBrowserReviewItemContext(snapshot, reviewItemId) {
  const matchingItems = snapshot.items.filter((candidate) => candidate.id === reviewItemId);
  if (matchingItems.length === 0) throw new Error("unknown review item");
  if (matchingItems.length !== 1) throw new Error("review item identity is ambiguous");
  const item = matchingItems[0];
  if (snapshot.kind === "scope" && item.kind === "code-section") {
    const file = snapshot.files.find((candidate) => candidate.path === item.path);
    if (!file || file.binary) throw new Error("review item source file is unavailable");
    const rows = file.lines.filter((line) => line.number >= item.range.start && line.number <= item.range.end).map((line, position) => ({
      id: reviewRowId(item.id, position),
      kind: "scope",
      line: line.number,
      text: line.text
    }));
    if (rows.length !== item.range.end - item.range.start + 1) throw new Error("incomplete item");
    return { item, rows };
  }
  if (snapshot.kind === "diff" && item.kind === "hunk") {
    const file = snapshot.files.find((candidate) => candidate.path === item.path);
    const matchingHunks = file?.hunks.filter(
      (candidate) => candidate.reviewItemId === item.id && candidate.reviewItemContentHash === item.contentHash && candidate.reviewItemLocationHash === item.locationHash && candidate.header === item.label && Math.max(1, candidate.newStart) === item.range.start && (candidate.newLines === 0 ? item.range.start : candidate.newStart + candidate.newLines - 1) === item.range.end
    );
    if (!matchingHunks || matchingHunks.length !== 1) {
      throw new Error("review item diff hunk is unavailable");
    }
    const hunk = matchingHunks[0];
    return {
      item,
      rows: hunk.lines.map((line, position) => ({
        id: reviewRowId(item.id, position),
        kind: line.kind,
        oldLine: line.oldLine,
        newLine: line.newLine,
        text: line.text,
        ...line.noNewlineAtEnd === void 0 ? {} : { noNewlineAtEnd: line.noNewlineAtEnd }
      }))
    };
  }
  if (snapshot.kind === "diff" && item.kind === "file") {
    const matchingFiles = snapshot.files.filter(
      (file) => file.path === item.path && file.reviewItemId === item.id && file.reviewItemContentHash === item.contentHash && file.reviewItemLocationHash === item.locationHash
    );
    if (matchingFiles.length !== 1) {
      throw new Error("review item file change is unavailable");
    }
    return { item, rows: [] };
  }
  throw new Error("review item kind does not match its snapshot");
}

// src/removals.ts
function deriveRemovalRuns(rows) {
  const runs = [];
  let current;
  for (const row of rows) {
    if (row.kind !== "remove" || row.oldLine === null) {
      current = void 0;
      continue;
    }
    if (current && current.end + 1 === row.oldLine) {
      current.end = row.oldLine;
      current.lineIds.push(row.id);
      current.texts.push(row.text);
      continue;
    }
    current = { start: row.oldLine, end: row.oldLine, lineIds: [row.id], texts: [row.text] };
    runs.push(current);
  }
  return runs;
}
function hunkDiffRows(snapshot, item) {
  const context = resolveBrowserReviewItemContext(snapshot, item.id);
  return context.rows.filter((row) => row.kind !== "scope");
}
function deriveSnapshotRemovalRuns(snapshot) {
  if (snapshot.kind !== "diff") return [];
  const runs = [];
  for (const item of snapshot.items) {
    if (item.kind !== "hunk") continue;
    for (const run of deriveRemovalRuns(hunkDiffRows(snapshot, item))) {
      runs.push({ ...run, reviewItemId: item.id, path: item.path });
    }
  }
  return runs;
}
function resolveRemovalTarget(snapshot, rationale) {
  const target = rationale.movedTo;
  if (target && snapshot.kind === "diff") {
    for (const item of snapshot.items) {
      if (item.kind !== "hunk" || item.path !== target.path) continue;
      const rowIds = hunkDiffRows(snapshot, item).filter(
        (row) => row.newLine !== null && row.newLine >= target.start && row.newLine <= target.end
      ).map((row) => row.id);
      if (rowIds.length > 0) {
        return {
          kind: "in-review",
          reviewItemId: item.id,
          rowIds,
          path: target.path,
          start: target.start,
          end: target.end
        };
      }
    }
  }
  const excerpt = rationale.movedToExcerpt;
  if (excerpt) return { kind: "excerpt", ...excerpt };
  return { kind: "unresolved" };
}
function buildRemovalStrips(rows, reviewItemId, snapshot, insights) {
  const rationales = (insights.removals ?? []).filter(
    (rationale) => rationale.reviewItemId === reviewItemId
  );
  return deriveRemovalRuns(rows).map((run) => {
    const rationale = rationales.find(
      (candidate) => candidate.run.start === run.start && candidate.run.end === run.end
    );
    return {
      run,
      ...rationale ? { rationale } : {},
      target: rationale ? resolveRemovalTarget(snapshot, rationale) : { kind: "unresolved" }
    };
  });
}

export {
  reviewRowId,
  deriveReviewReadiness,
  resolveBrowserReviewItemContext,
  deriveRemovalRuns,
  deriveSnapshotRemovalRuns,
  resolveRemovalTarget,
  buildRemovalStrips
};
//# sourceMappingURL=chunk-GOXPD7VI.js.map