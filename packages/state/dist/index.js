// src/paths.ts
import { join } from "node:path";
var STATE_DIRNAME = ".state";
function stateDir(sessionDir) {
  return join(sessionDir, STATE_DIRNAME);
}
function progressPath(sessionDir) {
  return join(stateDir(sessionDir), "progress.json");
}
function phaseJournalPath(sessionDir, phaseId) {
  return join(stateDir(sessionDir), "phases", `${phaseId}.md`);
}
function globalJournalPath(sessionDir) {
  return join(stateDir(sessionDir), "journal.md");
}
function handoffPath(sessionDir) {
  return join(stateDir(sessionDir), "handoff.md");
}

// src/progress.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join as join2 } from "node:path";
var DONE_STATUSES = /* @__PURE__ */ new Set(["done", "shipped"]);
function emptyProgress() {
  return { version: 1, overallStatus: "in-progress", resume: {}, phases: [] };
}
function readProgress(sessionDir) {
  const file = progressPath(sessionDir);
  if (!existsSync(file)) return emptyProgress();
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return {
    version: 1,
    overallStatus: parsed.overallStatus ?? "in-progress",
    resume: parsed.resume ?? {},
    phases: parsed.phases ?? [],
    updatedAt: parsed.updatedAt
  };
}
function writeProgress(sessionDir, data) {
  const file = progressPath(sessionDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join2(dirname(file), `.progress.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}
`, "utf8");
  renameSync(tmp, file);
}
function deriveProgress(progress) {
  const total = progress.phases.length;
  const done = progress.phases.filter((p) => DONE_STATUSES.has(p.status)).length;
  const percent = total === 0 ? 0 : Math.round(done / total * 100);
  return { done, total, percent };
}

// src/handoff.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
var defaultNow = () => (/* @__PURE__ */ new Date()).toISOString();
function writeHandoff(sessionDir, body, now = defaultNow) {
  const file = handoffPath(sessionDir);
  mkdirSync2(dirname2(file), { recursive: true });
  const stamp = now();
  const contents = `# Handoff \u2014 ${stamp}

${body.trimEnd()}
`;
  const tmp = join3(dirname2(file), `.handoff.${stamp.replace(/[:.]/g, "-")}.tmp`);
  writeFileSync2(tmp, contents, "utf8");
  renameSync2(tmp, file);
}
function readHandoff(sessionDir) {
  const file = handoffPath(sessionDir);
  return existsSync2(file) ? readFileSync2(file, "utf8") : null;
}

// src/mutations.ts
import { appendFileSync, mkdirSync as mkdirSync3 } from "node:fs";
import { dirname as dirname3 } from "node:path";
var defaultNow2 = () => (/* @__PURE__ */ new Date()).toISOString();
var DONE = /* @__PURE__ */ new Set(["done", "shipped"]);
function appendTo(absPath, text) {
  mkdirSync3(dirname3(absPath), { recursive: true });
  appendFileSync(absPath, text, "utf8");
}
function setPhaseStatus(sessionDir, phaseId, status, opts = {}) {
  const now = (opts.now ?? defaultNow2)();
  const progress = readProgress(sessionDir);
  let phase = progress.phases.find((p) => p.slug === phaseId);
  if (!phase) {
    phase = { slug: phaseId, status };
    progress.phases.push(phase);
  }
  if (status === "in-progress" && !phase.startedAt) phase.startedAt = now;
  if (DONE.has(status)) phase.completedAt = now;
  phase.status = status;
  phase.updatedAt = now;
  progress.updatedAt = now;
  writeProgress(sessionDir, progress);
  if (opts.note) {
    appendTo(phaseJournalPath(sessionDir, phaseId), `
## ${status} \u2014 ${now}
${opts.note}
`);
  }
}
function appendFinding(sessionDir, target, text, now = defaultNow2) {
  const stamp = now();
  const path = "global" in target ? globalJournalPath(sessionDir) : phaseJournalPath(sessionDir, target.phase);
  appendTo(path, `- ${stamp}: ${text}
`);
}
function setResume(sessionDir, resume, now = defaultNow2) {
  const progress = readProgress(sessionDir);
  const merged = { ...progress.resume };
  if (resume.nextPhase !== void 0) merged.nextPhase = resume.nextPhase;
  if (resume.note !== void 0) merged.note = resume.note;
  progress.resume = merged;
  progress.updatedAt = now();
  writeProgress(sessionDir, progress);
}

// src/journals.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
function readPhaseJournal(sessionDir, phaseId) {
  const file = phaseJournalPath(sessionDir, phaseId);
  return existsSync3(file) ? readFileSync3(file, "utf8") : null;
}
function readGlobalJournal(sessionDir) {
  const file = globalJournalPath(sessionDir);
  return existsSync3(file) ? readFileSync3(file, "utf8") : null;
}

// src/feedback-files.ts
var REVIEW_DONE_FILE = ".review-done";
var LISTENING_FILE = ".listening";

// src/schema.ts
var progressJsonSchema = {
  type: "object",
  required: ["version", "phases"],
  additionalProperties: true,
  properties: {
    version: { const: 1 },
    overallStatus: {
      enum: ["draft", "proposed", "in-progress", "blocked", "done", "shipped"]
    },
    resume: {
      type: "object",
      properties: { nextPhase: { type: "string" }, note: { type: "string" } }
    },
    phases: {
      type: "array",
      items: {
        type: "object",
        required: ["slug", "status"],
        properties: {
          slug: { type: "string" },
          status: {
            enum: ["draft", "proposed", "in-progress", "blocked", "done", "shipped"]
          },
          startedAt: { type: "string" },
          completedAt: { type: "string" },
          updatedAt: { type: "string" }
        }
      }
    }
  }
};
export {
  LISTENING_FILE,
  REVIEW_DONE_FILE,
  STATE_DIRNAME,
  appendFinding,
  deriveProgress,
  emptyProgress,
  globalJournalPath,
  handoffPath,
  phaseJournalPath,
  progressJsonSchema,
  progressPath,
  readGlobalJournal,
  readHandoff,
  readPhaseJournal,
  readProgress,
  setPhaseStatus,
  setResume,
  stateDir,
  writeHandoff,
  writeProgress
};
//# sourceMappingURL=index.js.map