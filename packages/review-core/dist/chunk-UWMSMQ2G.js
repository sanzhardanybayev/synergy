// src/hash.ts
import { createHash } from "node:crypto";
function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// src/diff.ts
import { TextDecoder, TextEncoder } from "node:util";

// src/review-item-identity.ts
function findDuplicateReviewItemId(items) {
  const ids = /* @__PURE__ */ new Set();
  for (const item of items) {
    if (ids.has(item.id)) return item.id;
    ids.add(item.id);
  }
  return void 0;
}

// src/diff.ts
var HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
var OCTAL_ESCAPE_PATTERN = /^[0-7]{3}$/u;
var PATH_ENCODER = new TextEncoder();
var C_STYLE_ESCAPE_BYTES = /* @__PURE__ */ new Map([
  ["a", 7],
  ["b", 8],
  ["f", 12],
  ["n", 10],
  ["r", 13],
  ["t", 9],
  ["v", 11],
  ["\\", 92],
  ['"', 34]
]);
function assertSafeRepositoryPath(path) {
  if (path.length === 0 || path.startsWith("/") || path.startsWith("\\") || path.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")) {
    throw new Error(`invalid repository-relative path: ${path}`);
  }
}
function stripDiffPath(path) {
  if (path === "/dev/null") return path;
  const stripped = path.replace(/^[ab]\//u, "");
  assertSafeRepositoryPath(stripped);
  return stripped;
}
function readQuotedPath(value, start) {
  const bytes = [];
  let index = start + 1;
  while (index < value.length) {
    const character = value[index];
    if (character === '"') {
      try {
        return {
          path: new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)),
          next: index + 1
        };
      } catch {
        return null;
      }
    }
    if (character !== "\\") {
      const codePoint = value.codePointAt(index);
      if (codePoint === void 0) return null;
      const literal = String.fromCodePoint(codePoint);
      bytes.push(...PATH_ENCODER.encode(literal));
      index += literal.length;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === void 0) return null;
    const octal = value.slice(index + 1, index + 4);
    if (OCTAL_ESCAPE_PATTERN.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 4;
      continue;
    }
    const escapedByte = C_STYLE_ESCAPE_BYTES.get(escaped);
    if (escapedByte === void 0) return null;
    bytes.push(escapedByte);
    index += 2;
  }
  return null;
}
function readDiffHeaderPaths(value) {
  const paths = [];
  let index = 0;
  while (index < value.length) {
    while (value[index] === " ") index += 1;
    if (index === value.length) break;
    if (value[index] === '"') {
      const quoted = readQuotedPath(value, index);
      if (!quoted) return null;
      paths.push(quoted.path);
      index = quoted.next;
      continue;
    }
    const nextSpace = value.indexOf(" ", index);
    if (nextSpace === -1) {
      paths.push(value.slice(index));
      break;
    }
    paths.push(value.slice(index, nextSpace));
    index = nextSpace + 1;
  }
  return paths;
}
function readPatchPath(value) {
  const pathWithMetadata = value.split("	", 1)[0];
  if (!pathWithMetadata.startsWith('"')) return pathWithMetadata;
  const quoted = readQuotedPath(pathWithMetadata, 0);
  if (!quoted || quoted.next !== pathWithMetadata.length) {
    throw new Error(`invalid quoted diff path: ${value}`);
  }
  return quoted.path;
}
function parseGitHeaderPaths(line) {
  const paths = readDiffHeaderPaths(line.slice("diff --git ".length));
  if (!paths || paths.length !== 2) throw new Error(`invalid diff header: ${line}`);
  return { oldPath: stripDiffPath(paths[0]), newPath: stripDiffPath(paths[1]) };
}
function createDiffFile(oldPath, newPath) {
  return {
    path: newPath,
    previousPath: oldPath === newPath ? void 0 : oldPath,
    status: "modified",
    additions: 0,
    deletions: 0,
    binary: false,
    hunks: []
  };
}
function parseHunk(line) {
  const match = HUNK_HEADER_PATTERN.exec(line);
  if (!match) return null;
  return {
    header: line,
    oldStart: Number.parseInt(match[1], 10),
    oldLines: match[2] === void 0 ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3], 10),
    newLines: match[4] === void 0 ? 1 : Number.parseInt(match[4], 10),
    lines: []
  };
}
function appendHunkLine(hunk, line, oldLine, newLine) {
  let diffLine;
  if (line.startsWith("+")) {
    diffLine = { kind: "add", text: line.slice(1), oldLine: null, newLine };
    hunk.lines.push(diffLine);
    return { oldLine, newLine: newLine + 1, addition: true, deletion: false };
  }
  if (line.startsWith("-")) {
    diffLine = { kind: "remove", text: line.slice(1), oldLine, newLine: null };
    hunk.lines.push(diffLine);
    return { oldLine: oldLine + 1, newLine, addition: false, deletion: true };
  }
  if (line.startsWith(" ")) {
    diffLine = { kind: "context", text: line.slice(1), oldLine, newLine };
    hunk.lines.push(diffLine);
    return { oldLine: oldLine + 1, newLine: newLine + 1, addition: false, deletion: false };
  }
  return null;
}
function parseUnifiedDiff(patch) {
  const files = [];
  const patchLinesByFile = /* @__PURE__ */ new Map();
  let currentFile = null;
  let currentHunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const { oldPath, newPath } = parseGitHeaderPaths(line);
      currentFile = createDiffFile(oldPath, newPath);
      files.push(currentFile);
      patchLinesByFile.set(currentFile, [line]);
      currentHunk = null;
      continue;
    }
    if (!currentFile) continue;
    patchLinesByFile.get(currentFile).push(line);
    if (line.startsWith("new file mode ")) {
      currentFile.status = "added";
      currentFile.newMode = line.slice("new file mode ".length);
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      currentFile.status = "deleted";
      currentFile.oldMode = line.slice("deleted file mode ".length);
      continue;
    }
    if (line.startsWith("old mode ")) {
      currentFile.oldMode = line.slice("old mode ".length);
      continue;
    }
    if (line.startsWith("new mode ")) {
      currentFile.newMode = line.slice("new mode ".length);
      continue;
    }
    if (line.startsWith("rename from ")) {
      const previousPath = stripDiffPath(`a/${readPatchPath(line.slice("rename from ".length))}`);
      currentFile.previousPath = previousPath;
      currentFile.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      currentFile.path = stripDiffPath(`b/${readPatchPath(line.slice("rename to ".length))}`);
      currentFile.status = "renamed";
      continue;
    }
    if (line.startsWith("copy from ")) {
      currentFile.previousPath = stripDiffPath(
        `a/${readPatchPath(line.slice("copy from ".length))}`
      );
      currentFile.status = "copied";
      continue;
    }
    if (line.startsWith("copy to ")) {
      currentFile.path = stripDiffPath(`b/${readPatchPath(line.slice("copy to ".length))}`);
      currentFile.status = "copied";
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      currentFile.binary = true;
      currentFile.status = "binary";
      currentHunk = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      const oldPath = stripDiffPath(readPatchPath(line.slice(4)));
      if (oldPath === "/dev/null") {
        currentFile.status = "added";
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = stripDiffPath(readPatchPath(line.slice(4)));
      if (newPath === "/dev/null") {
        currentFile.status = "deleted";
      }
      continue;
    }
    const hunk = parseHunk(line);
    if (hunk) {
      currentFile.hunks.push(hunk);
      currentHunk = hunk;
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!currentHunk) continue;
    if (line === "\\ No newline at end of file") {
      const previousLine = currentHunk.lines.at(-1);
      if (previousLine) previousLine.noNewlineAtEnd = true;
      continue;
    }
    const next = appendHunkLine(currentHunk, line, oldLine, newLine);
    if (!next) continue;
    oldLine = next.oldLine;
    newLine = next.newLine;
    if (next.addition) currentFile.additions += 1;
    if (next.deletion) currentFile.deletions += 1;
  }
  for (const file of files) {
    if (file.binary) file.binaryPatchHash = hashText(patchLinesByFile.get(file).join("\n"));
  }
  return files;
}
function canonicalDiffLine(line) {
  const newlineMarker = line.noNewlineAtEnd ? "\n\\ No newline at end of file" : "";
  return `${line.kind}:${line.text}${newlineMarker}`;
}
function createHunkReviewItem(path, hunk) {
  const selected = hunk.lines.filter((line) => line.kind !== "context").map(canonicalDiffLine).join("\n");
  const context = hunk.lines.map(canonicalDiffLine).join("\n");
  const rangeStart = Math.max(1, hunk.newStart);
  const range = {
    start: rangeStart,
    end: hunk.newLines === 0 ? rangeStart : rangeStart + hunk.newLines - 1
  };
  return {
    id: `hunk-${hashText(`${path}
${context}`).slice(0, 16)}`,
    kind: "hunk",
    path,
    label: hunk.header,
    range,
    contentHash: hashText(selected),
    locationHash: hashText(`${path}
${context}`)
  };
}
function fileReviewLabel(file) {
  if (file.binary) return "Binary file changed";
  if (file.status === "renamed") return "File renamed";
  if (file.status === "copied") return "File copied";
  if (file.status === "added") return "Empty file added";
  if (file.status === "deleted") return "Empty file deleted";
  if (file.oldMode || file.newMode) return "File mode changed";
  return "File metadata changed";
}
function createFileReviewItem(file) {
  const content = [
    file.status,
    file.previousPath ?? "",
    file.oldMode ?? "",
    file.newMode ?? "",
    file.binaryPatchHash ?? ""
  ].join("\n");
  const location = `${file.path}
${file.previousPath ?? ""}`;
  const contentHash = hashText(content);
  const locationHash = hashText(location);
  return {
    id: `file-${hashText(`${location}
${content}`).slice(0, 16)}`,
    kind: "file",
    path: file.path,
    label: fileReviewLabel(file),
    range: { start: 1, end: 1 },
    contentHash,
    locationHash
  };
}
function buildDiffSnapshot(input) {
  const files = parseUnifiedDiff(input.patch);
  const entries = files.flatMap(
    (file) => file.hunks.map((hunk) => ({ file, hunk, item: createHunkReviewItem(file.path, hunk) }))
  );
  const semanticIdCounts = /* @__PURE__ */ new Map();
  for (const { item } of entries) {
    semanticIdCounts.set(item.id, (semanticIdCounts.get(item.id) ?? 0) + 1);
  }
  const capturedRangeOccurrences = /* @__PURE__ */ new Map();
  const items = entries.map(({ file, hunk, item: semanticItem }) => {
    let item = semanticItem;
    if ((semanticIdCounts.get(semanticItem.id) ?? 0) > 1) {
      const capturedRange = `${hunk.oldStart}:${hunk.oldLines}:${hunk.newStart}:${hunk.newLines}`;
      const occurrenceKey = `${semanticItem.id}
${capturedRange}`;
      const occurrence = (capturedRangeOccurrences.get(occurrenceKey) ?? 0) + 1;
      capturedRangeOccurrences.set(occurrenceKey, occurrence);
      const rangeDiscriminator = hashText(`${file.path}
${capturedRange}
${occurrence}`).slice(
        0,
        16
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
    ...input.predecessorRevisionId === void 0 ? {} : { predecessorRevisionId: input.predecessorRevisionId },
    source: input.source,
    fingerprint: input.fingerprint,
    createdAt: input.createdAt,
    kind: "diff",
    files,
    items
  };
}

// src/source-capture.ts
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { TextDecoder as TextDecoder2 } from "node:util";
function stringifyOutput(value) {
  if (typeof value === "string") return value;
  return value?.toString("utf8") ?? "";
}
var systemCommandRunner = {
  run(command, args, options) {
    try {
      return {
        exitCode: 0,
        stdout: execFileSync(command, args, { cwd: options.cwd }),
        stderr: ""
      };
    } catch (error) {
      const commandError = error;
      return {
        exitCode: commandError.status ?? 1,
        stdout: stringifyOutput(commandError.stdout),
        stderr: commandError.code === "ENOENT" ? commandError.code : stringifyOutput(commandError.stderr)
      };
    }
  }
};
function assertSafeRepositoryPath2(path) {
  if (path.length === 0 || path.includes("\0") || path.startsWith("/") || path.startsWith("\\") || path.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")) {
    throw new Error(`invalid repository-relative path: ${path}`);
  }
}
function parseNulPaths(value) {
  const paths = [];
  let start = 0;
  for (let end = value.indexOf(0, start); end !== -1; end = value.indexOf(0, start)) {
    if (end > start) {
      const bytes = value.subarray(start, end);
      const path = decodeUtf8(bytes);
      if (path === void 0) {
        throw new Error(
          "Git returned a non-UTF-8 repository path; rename it before review capture."
        );
      }
      paths.push(path);
    }
    start = end + 1;
  }
  if (start < value.length) {
    const path = decodeUtf8(value.subarray(start));
    if (path === void 0) {
      throw new Error("Git returned a non-UTF-8 repository path; rename it before review capture.");
    }
    paths.push(path);
  }
  for (const path of paths) assertSafeRepositoryPath2(path);
  return [...new Set(paths)].sort();
}
var PREVIEW_RUNTIME_PATHS = /* @__PURE__ */ new Set([
  ".synergy/preview.runtime.json",
  ".synergy/preview.runtime.json.mutation.lock",
  ".synergy/preview.start.lock",
  ".synergy/preview.pid",
  ".synergy/preview.log"
]);
function isPreviewRuntimePath(path) {
  return PREVIEW_RUNTIME_PATHS.has(path) || path.startsWith(".synergy/preview.runtime.json.quarantine.") || path.startsWith(".synergy/.preview.runtime.json.") && path.endsWith(".tmp") || path.startsWith(".synergy/preview.start.lock.quarantine.") || path.startsWith(".synergy/preview.start.lock.owner.tmp.");
}
function filterPreviewRuntimePatch(patch) {
  return patch.split(/(?=^diff --git )/mu).filter((chunk) => {
    const files = parseUnifiedDiff(chunk);
    if (files.length === 0) return true;
    return files.every(
      (file) => !isPreviewRuntimePath(file.path) && (file.previousPath === void 0 || !isPreviewRuntimePath(file.previousPath))
    );
  }).join("");
}
var UTF8_DECODER = new TextDecoder2("utf-8", { fatal: true });
function decodeUtf8(bytes) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return void 0;
  }
}
function readRepositoryEntry(root, path, readFile) {
  assertSafeRepositoryPath2(path);
  try {
    const lexicalRoot = resolve(root);
    const lexicalPath = resolve(lexicalRoot, path);
    if (relative(lexicalRoot, lexicalPath).startsWith("..")) {
      throw new Error(`repository path escapes root: ${path}`);
    }
    if (readFile) return { bytes: Buffer.from(readFile(lexicalPath), "utf8"), mode: 33188 };
    const canonicalRoot = realpathSync(root);
    const absolutePath = resolve(canonicalRoot, path);
    let currentPath = canonicalRoot;
    for (const segment of path.split("/")) {
      currentPath = join(currentPath, segment);
      if (lstatSync(currentPath).isSymbolicLink()) {
        throw new Error(`eligible path contains a symbolic link: ${path}`);
      }
    }
    const resolvedPath = realpathSync(absolutePath);
    if (relative(canonicalRoot, resolvedPath).startsWith("..")) {
      throw new Error(`repository path escapes root: ${path}`);
    }
    const metadata = lstatSync(resolvedPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`eligible path is a symbolic link: ${path}`);
    }
    if (!metadata.isFile()) throw new Error(`eligible path is not a regular file: ${path}`);
    return { bytes: readFileSync(resolvedPath), mode: metadata.mode };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/symbolic link/u.test(detail)) throw error;
    throw new Error(`unable to read eligible file ${path}: ${detail}`);
  }
}
function quoteGitPath(path) {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}
function gitFileMode(mode) {
  return mode & 73 ? "100755" : "100644";
}
function syntheticAddedFilePatch(path, entry) {
  const oldPath = quoteGitPath(`a/${path}`);
  const newPath = quoteGitPath(`b/${path}`);
  const content = decodeUtf8(entry.bytes);
  if (entry.bytes.includes(0) || content === void 0) {
    return [
      `diff --git ${oldPath} ${newPath}`,
      `new file mode ${gitFileMode(entry.mode)}`,
      `Binary files /dev/null and ${newPath} differ`,
      `# synergy-binary-sha256 ${hashText(entry.bytes.toString("base64"))}`
    ].join("\n");
  }
  const hasFinalNewline = content.endsWith("\n");
  const lines = content.length === 0 ? [] : content.split("\n");
  if (hasFinalNewline) lines.pop();
  const additions = lines.map((line) => `+${line}`);
  const hunk = lines.length === 0 ? [] : [`@@ -0,0 +1,${lines.length} @@`, ...additions];
  if (!hasFinalNewline && lines.length > 0) hunk.push("\\ No newline at end of file");
  return [
    `diff --git ${oldPath} ${newPath}`,
    `new file mode ${gitFileMode(entry.mode)}`,
    "--- /dev/null",
    `+++ ${newPath}`,
    ...hunk
  ].join("\n");
}
function commandFailure(command, result) {
  const detail = `${result.stderr}
${result.stdout}`.trim();
  const lower = detail.toLowerCase();
  if (result.stderr === "ENOENT") {
    return new Error(
      command === "gh" ? "GitHub CLI (gh) is required for PR reviews. Install it, then run gh auth login." : "Git is required for review capture. Install Git and run this command inside a repository."
    );
  }
  if (command === "gh" && /auth|login|not logged/i.test(lower)) {
    return new Error("GitHub PR access is unavailable. Run gh auth login, then retry the review.");
  }
  if (command === "git" && /not a git repository/i.test(lower)) {
    return new Error(
      "Review capture requires a Git repository. Run this command from a repository root."
    );
  }
  return new Error(
    `${command === "gh" ? "GitHub PR capture" : "Git capture"} failed${detail ? `: ${detail}` : ""}`
  );
}
function runChecked(runner, root, command, args) {
  const result = runner.run(command, args, { cwd: root });
  if (result.exitCode !== 0) throw commandFailure(command, result);
  return stringifyOutput(result.stdout);
}
function runCheckedBuffer(runner, root, command, args) {
  const result = runner.run(command, args, { cwd: root });
  if (result.exitCode !== 0) throw commandFailure(command, result);
  return typeof result.stdout === "string" ? Buffer.from(result.stdout, "utf8") : result.stdout;
}
function assertCapturedPatch(patch, source) {
  const files = parseUnifiedDiff(patch);
  if (files.length === 0)
    throw new Error(`No ${source} changes were found; no review was created.`);
  return files.map((file) => file.path).sort();
}
function sourceFingerprint(source, content) {
  return hashText(`${JSON.stringify(source)}
${content}`);
}
function readTextSourceFiles(root, paths, readFile) {
  const files = [];
  const content = [];
  for (const path of paths) {
    const entry = readRepositoryEntry(root, path, readFile);
    const text = decodeUtf8(entry.bytes);
    content.push(
      `${path}\0${gitFileMode(entry.mode)}\0${hashText(entry.bytes.toString("base64"))}`
    );
    if (entry.bytes.includes(0) || text === void 0) {
      files.push({ path, lines: [], binary: true });
      continue;
    }
    files.push({
      path,
      binary: false,
      lines: text.split(/\r?\n/u).map((line, index) => ({ number: index + 1, text: line }))
    });
  }
  return { files, fingerprintContent: content.join("\n") };
}
function parsePullRequestView(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      "GitHub PR capture returned invalid metadata. Retry after checking gh authentication."
    );
  }
  if (typeof parsed !== "object" || parsed === null || !("number" in parsed) || !("title" in parsed) || !("url" in parsed) || !("baseRefOid" in parsed) || !("headRefOid" in parsed) || typeof parsed.number !== "number" || typeof parsed.title !== "string" || typeof parsed.url !== "string" || typeof parsed.baseRefOid !== "string" || typeof parsed.headRefOid !== "string") {
    throw new Error(
      "GitHub PR capture returned incomplete metadata. Retry with a valid PR number or URL."
    );
  }
  return {
    number: parsed.number,
    title: parsed.title,
    url: parsed.url,
    baseRefOid: parsed.baseRefOid,
    headRefOid: parsed.headRefOid
  };
}
function capturePr(options) {
  const runner = options.runner ?? systemCommandRunner;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = parsePullRequestView(
      runChecked(runner, options.root, "gh", [
        "pr",
        "view",
        options.selector,
        "--json",
        "number,title,url,baseRefOid,headRefOid"
      ])
    );
    const patch = filterPreviewRuntimePatch(
      runChecked(runner, options.root, "gh", ["pr", "diff", before.url, "--patch"])
    );
    const after = parsePullRequestView(
      runChecked(runner, options.root, "gh", [
        "pr",
        "view",
        before.url,
        "--json",
        "number,title,url,baseRefOid,headRefOid"
      ])
    );
    if (before.baseRefOid !== after.baseRefOid || before.headRefOid !== after.headRefOid) continue;
    const source = {
      kind: "pr",
      number: after.number,
      url: after.url,
      baseSha: after.baseRefOid,
      headSha: after.headRefOid
    };
    const eligiblePaths = assertCapturedPatch(patch, "PR");
    return {
      source,
      title: after.title,
      patch,
      eligiblePaths,
      fingerprint: sourceFingerprint(source, patch)
    };
  }
  throw new Error(
    "The PR changed while its diff was captured. Retry after the PR head stabilizes."
  );
}
function captureStaged(options) {
  const runner = options.runner ?? systemCommandRunner;
  const patch = filterPreviewRuntimePatch(
    runChecked(runner, options.root, "git", [
      "diff",
      "--cached",
      "--no-ext-diff",
      "--binary"
    ])
  );
  const source = { kind: "staged", headSha: "" };
  const eligiblePaths = assertCapturedPatch(patch, "staged");
  return { source, patch, eligiblePaths, fingerprint: sourceFingerprint(source, patch) };
}
function captureUnstaged(options) {
  const runner = options.runner ?? systemCommandRunner;
  const trackedPatch = filterPreviewRuntimePatch(
    runChecked(runner, options.root, "git", [
      "diff",
      "--no-ext-diff",
      "--binary",
      "--",
      ":(exclude).synergy/preview.runtime.json",
      ":(exclude).synergy/preview.runtime.json.*",
      ":(exclude).synergy/.preview.runtime.json.*.tmp",
      ":(exclude).synergy/preview.start.lock",
      ":(exclude).synergy/preview.start.lock.*",
      ":(exclude).synergy/preview.pid",
      ":(exclude).synergy/preview.log"
    ])
  );
  const untrackedPaths = parseNulPaths(
    runCheckedBuffer(runner, options.root, "git", [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z"
    ])
  ).filter((path) => !isPreviewRuntimePath(path));
  const untrackedEntries = untrackedPaths.map((path) => ({
    path,
    entry: readRepositoryEntry(options.root, path, options.readFile)
  }));
  const untrackedPatches = untrackedEntries.map(
    ({ path, entry }) => syntheticAddedFilePatch(path, entry)
  );
  const patch = [trackedPatch.trimEnd(), ...untrackedPatches].filter(Boolean).join("\n");
  const source = { kind: "unstaged", headSha: "" };
  const eligiblePaths = assertCapturedPatch(patch, "unstaged");
  const fingerprintContent = [
    patch,
    ...untrackedEntries.map(
      ({ path, entry }) => `${path}\0${gitFileMode(entry.mode)}\0${hashText(entry.bytes.toString("base64"))}`
    )
  ].join("\n");
  return {
    source,
    patch,
    eligiblePaths,
    fingerprintContent,
    fingerprint: sourceFingerprint(source, fingerprintContent)
  };
}
function captureScope(options) {
  if (options.patterns.length === 0)
    throw new Error("Scope review requires at least one repository-relative path.");
  const patterns = [...new Set(options.patterns.map(normalizeScopePattern))].sort();
  for (const pattern of patterns) assertSafeRepositoryPath2(pattern);
  const runner = options.runner ?? systemCommandRunner;
  const paths = parseNulPaths(
    runCheckedBuffer(runner, options.root, "git", [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...patterns
    ])
  ).filter((path) => !isPreviewRuntimePath(path));
  if (paths.length === 0)
    throw new Error("Scope resolved to no eligible files. Choose a different path.");
  const source = { kind: "scope", patterns, headSha: "" };
  const captured = readTextSourceFiles(options.root, paths, options.readFile);
  if (captured.files.every((file) => file.binary)) {
    throw new Error("Scope contains only binary files; choose text files to review.");
  }
  return {
    source,
    files: captured.files,
    eligiblePaths: paths,
    fingerprintContent: captured.fingerprintContent,
    fingerprint: sourceFingerprint(source, captured.fingerprintContent)
  };
}
function captureReviewSource(request) {
  if (request.source.kind === "pr") {
    return capturePr({ ...request, selector: request.source.selector });
  }
  const runner = request.runner ?? systemCommandRunner;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = runChecked(runner, request.root, "git", ["rev-parse", "HEAD"]).trim();
    const captured = request.source.kind === "staged" ? captureStaged(request) : request.source.kind === "unstaged" ? captureUnstaged(request) : captureScope({ ...request, patterns: request.source.patterns });
    const after = runChecked(runner, request.root, "git", ["rev-parse", "HEAD"]).trim();
    if (before !== after) continue;
    const source = { ...captured.source, headSha: after };
    const fingerprintContent = captured.fingerprintContent ?? captured.patch ?? "";
    return { ...captured, source, fingerprint: sourceFingerprint(source, fingerprintContent) };
  }
  throw new Error(
    "Local Git HEAD changed while the review source was captured. Retry after it stabilizes."
  );
}
function recaptureReviewSource(source, root, dependencies = {}) {
  const requestSource = source.kind === "pr" ? { kind: "pr", selector: source.url } : source.kind === "scope" ? { kind: "scope", patterns: source.patterns } : { kind: source.kind };
  return captureReviewSource({ root, ...dependencies, source: requestSource });
}
function compareReviewSourceFreshness(snapshot, root, dependencies = {}) {
  try {
    const captured = recaptureReviewSource(snapshot.source, root, dependencies);
    return { sourceChanged: captured.fingerprint !== snapshot.fingerprint, captureFailed: false };
  } catch {
    return { sourceChanged: true, captureFailed: true };
  }
}
function normalizeScopePattern(pattern) {
  let normalized = pattern;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}
function resolveRepositoryRoot(root, runner = systemCommandRunner) {
  const gitRoot = runChecked(runner, root, "git", ["rev-parse", "--show-toplevel"]).trim();
  if (!gitRoot) throw new Error("Git did not return a repository root for review capture.");
  return existsSync(gitRoot) ? realpathSync(gitRoot) : resolve(gitRoot);
}
function repositoryName(root) {
  return basename(resolve(root)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repository";
}

export {
  hashText,
  findDuplicateReviewItemId,
  parseUnifiedDiff,
  createHunkReviewItem,
  createFileReviewItem,
  buildDiffSnapshot,
  systemCommandRunner,
  capturePr,
  captureStaged,
  captureUnstaged,
  captureScope,
  captureReviewSource,
  recaptureReviewSource,
  compareReviewSourceFreshness,
  resolveRepositoryRoot,
  repositoryName
};
//# sourceMappingURL=chunk-UWMSMQ2G.js.map