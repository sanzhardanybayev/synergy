#!/usr/bin/env node

// src/cli.ts
import { resolve as resolve2 } from "node:path";
import { bold, dim, green, red, yellow } from "kleur/colors";

// src/validate.ts
import { existsSync as existsSync3, readdirSync as readdirSync2, statSync as statSync3 } from "node:fs";
import { join as join2, resolve } from "node:path";
import {
  collectAgentNames,
  componentNames,
  flattenAgentTree,
  schemas
} from "@synergy/spec-kit";
import Ajv2 from "ajv";

// src/cache.ts
import { statSync } from "node:fs";

// src/parse.ts
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import GithubSlugger from "github-slugger";
import JSON5 from "json5";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
var processor = unified().use(remarkParse).use(remarkMdx);
function extractText(node) {
  if (!node || typeof node !== "object") return "";
  const n = node;
  if (typeof n.value === "string") return n.value;
  if (Array.isArray(n.children)) {
    return n.children.map(extractText).join("");
  }
  return "";
}
function attributeValueToJs(value) {
  if (value == null) return { parsed: true, value: true };
  if (typeof value === "string") return { parsed: true, value };
  const expr = value.value;
  if (typeof expr !== "string") return { parsed: false, value: void 0 };
  const trimmed = expr.trim();
  try {
    return { parsed: true, value: JSON5.parse(trimmed) };
  } catch {
    return { parsed: false, value: void 0 };
  }
}
function parseSpec(filePath) {
  const source = readFileSync(filePath, "utf8");
  const tree = processor.parse(source);
  const slug = basename(filePath).replace(/\.mdx?$/i, "");
  const slugger = new GithubSlugger();
  const headingSlugs = /* @__PURE__ */ new Set();
  const components = [];
  visit(tree, (node) => {
    if (!node || typeof node !== "object") return;
    const n = node;
    if (n.type === "heading") {
      const text = extractText(node);
      const headingSlug = slugger.slug(text);
      headingSlugs.add(headingSlug);
      return;
    }
    if (n.type === "mdxJsxFlowElement" || n.type === "mdxJsxTextElement") {
      if (!n.name) return;
      const attrs = {};
      const unparsed = [];
      for (const attr of n.attributes ?? []) {
        if (attr.type !== "mdxJsxAttribute") continue;
        const { parsed, value } = attributeValueToJs(attr.value);
        if (parsed) {
          attrs[attr.name] = value;
        } else {
          unparsed.push(attr.name);
        }
      }
      components.push({
        name: n.name,
        attributes: attrs,
        unparsedAttributes: unparsed,
        line: n.position?.start?.line,
        column: n.position?.start?.column
      });
    }
  });
  return { slug, filePath, headingSlugs, components };
}

// src/cache.ts
var cache = /* @__PURE__ */ new Map();
function parseSpecCached(filePath) {
  const stat = statSync(filePath);
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.spec;
  const spec = parseSpec(filePath);
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, spec });
  return spec;
}

// src/phase.ts
import { existsSync, readFileSync as readFileSync2, readdirSync, statSync as statSync2 } from "node:fs";
import { join } from "node:path";
function hasFrontmatterTitle(specPath) {
  let raw;
  try {
    raw = readFileSync2(specPath, "utf8");
  } catch {
    return false;
  }
  const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!fm) return false;
  return /^title:\s*\S/m.test(fm[1]);
}
var MAX_SLUG_LENGTH = 40;
var KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var PHASE_FOLDER_RE = /^(\d{2})-(.+)$/;
function listPhases(sessionDir) {
  const phasesDir = join(sessionDir, "phases");
  let entries;
  try {
    entries = readdirSync(phasesDir);
  } catch {
    return [];
  }
  const phases = [];
  for (const name of entries) {
    const dir = join(phasesDir, name);
    try {
      if (!statSync2(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const match = PHASE_FOLDER_RE.exec(name);
    if (!match) {
      phases.push({
        folderName: name,
        dir,
        order: void 0,
        slug: void 0,
        malformed: true
      });
      continue;
    }
    const order = Number.parseInt(match[1], 10);
    const slug = match[2];
    phases.push({
      folderName: name,
      dir,
      order,
      slug,
      malformed: false
    });
  }
  phases.sort((a, b) => {
    if (a.malformed && !b.malformed) return 1;
    if (!a.malformed && b.malformed) return -1;
    if (a.order !== void 0 && b.order !== void 0) return a.order - b.order;
    return a.folderName.localeCompare(b.folderName);
  });
  return phases;
}
function validatePhaseStructure(sessionDir) {
  const phases = listPhases(sessionDir);
  if (phases.length === 0) return [];
  const issues = [];
  for (const phase of phases) {
    if (phase.malformed) {
      issues.push({
        file: phase.dir,
        severity: "error",
        message: `Phase folder "${phase.folderName}" does not match required format \`NN-<slug>\` (e.g. \`01-core\`)`
      });
    } else {
      const slug = phase.slug;
      if (slug.length > MAX_SLUG_LENGTH) {
        issues.push({
          file: phase.dir,
          severity: "error",
          message: `Phase folder "${phase.folderName}" slug is ${slug.length} chars (max ${MAX_SLUG_LENGTH})`
        });
      } else if (!KEBAB_CASE_RE.test(slug)) {
        issues.push({
          file: phase.dir,
          severity: "error",
          message: `Phase folder "${phase.folderName}" slug "${slug}" must be kebab-case (lowercase letters, digits, and hyphens; no leading/trailing/consecutive hyphens)`
        });
      }
    }
    if (!existsSync(join(phase.dir, "spec.mdx"))) {
      issues.push({
        file: phase.dir,
        severity: "error",
        message: `Phase folder "${phase.folderName}" is missing required file \`spec.mdx\``
      });
    }
    const specPath = join(phase.dir, "spec.mdx");
    if (existsSync(specPath) && !hasFrontmatterTitle(specPath)) {
      issues.push({
        file: specPath,
        severity: "warning",
        message: `Phase folder "${phase.folderName}" spec.mdx is missing a \`title\` (needed for the live timeline label)`
      });
    }
    if (!existsSync(join(phase.dir, "orchestrator.md"))) {
      issues.push({
        file: phase.dir,
        severity: "warning",
        message: `Phase folder "${phase.folderName}" has no \`orchestrator.md\` (recommended for multi-step phases)`
      });
    }
  }
  const orders = phases.filter((p) => !p.malformed && p.order !== void 0).map((p) => p.order).sort((a, b) => a - b);
  if (orders.length > 0) {
    const counts = /* @__PURE__ */ new Map();
    for (const o of orders) counts.set(o, (counts.get(o) ?? 0) + 1);
    const duplicates = [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n).sort((a, b) => a - b);
    for (const n of duplicates) {
      issues.push({
        file: join(sessionDir, "phases"),
        severity: "error",
        message: `Duplicate phase number ${String(n).padStart(2, "0")} \u2014 each \`NN\` prefix must be unique`
      });
    }
    const unique = [...counts.keys()].sort((a, b) => a - b);
    if (unique[0] !== 1) {
      issues.push({
        file: join(sessionDir, "phases"),
        severity: "error",
        message: `Phase numbering must start at 01 (lowest found: ${String(unique[0]).padStart(2, "0")})`
      });
    }
    const max = unique[unique.length - 1];
    for (let expected = 1; expected <= max; expected++) {
      if (!counts.has(expected)) {
        issues.push({
          file: join(sessionDir, "phases"),
          severity: "error",
          message: `Gap in phase sequence: missing phase ${String(expected).padStart(2, "0")} (sequence must be 1..N with no gaps)`
        });
      }
    }
  }
  return issues;
}
function resolvePhaseCrossRef(target, ctx) {
  const [head, anchor] = target.split("#");
  if (!head) return { ok: false, reason: "CrossRef `to` is empty" };
  const phasePrefix = "phases/";
  if (!head.startsWith(phasePrefix)) {
    return { ok: false, reason: `Not a phases/ CrossRef target: "${target}"` };
  }
  const slug = head.slice(phasePrefix.length);
  if (!slug) {
    return { ok: false, reason: `CrossRef "${target}" is missing a phase slug` };
  }
  const spec = ctx.phases.get(slug);
  if (!spec) {
    const known = [...ctx.phases.keys()];
    const hint = known.length > 0 ? ` (known phases: ${known.join(", ")})` : "";
    return { ok: false, reason: `Unknown phase slug "${slug}"${hint}` };
  }
  if (anchor && !spec.headingSlugs.has(anchor)) {
    return { ok: false, reason: `Unknown anchor "${anchor}" in phase "${slug}"` };
  }
  return { ok: true };
}

// src/state.ts
import { existsSync as existsSync2, readFileSync as readFileSync3 } from "node:fs";
import { progressJsonSchema, progressPath } from "@synergy/state";
import Ajv from "ajv";
var ajv = new Ajv({ allErrors: true, strict: false });
var validateProgress = ajv.compile(progressJsonSchema);
function validateStateForSession(sessionDir, knownPhaseIds) {
  const file = progressPath(sessionDir);
  if (!existsSync2(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync3(file, "utf8"));
  } catch (err) {
    return [
      {
        file,
        severity: "error",
        message: `progress.json is not valid JSON: ${err.message}`
      }
    ];
  }
  const issues = [];
  if (!validateProgress(parsed)) {
    for (const e of validateProgress.errors ?? []) {
      issues.push({
        file,
        severity: "error",
        message: `progress.json ${e.instancePath || "(root)"} ${e.message ?? "invalid"}`
      });
    }
    return issues;
  }
  const progress = parsed;
  for (const phase of progress.phases) {
    if (!knownPhaseIds.has(phase.slug)) {
      const known = [...knownPhaseIds];
      const hint = known.length ? ` (known: ${known.join(", ")})` : "";
      issues.push({
        file,
        severity: "error",
        message: `progress.json references unknown phase slug "${phase.slug}"${hint}`
      });
    }
  }
  return issues;
}

// src/validate.ts
var validatorsCache = null;
function getValidators() {
  if (validatorsCache) return validatorsCache;
  const ajv2 = new Ajv2({ allErrors: true, strict: false });
  const map = /* @__PURE__ */ new Map();
  for (const name of componentNames) {
    map.set(name, ajv2.compile(schemas[name]));
  }
  validatorsCache = map;
  return map;
}
var REQUIRED_OVERVIEW_HEADINGS = ["summary", "goals"];
var PHASE_REF_PREFIX = "phases/";
var LEGACY_PHASE_REF_RE = /^[0-9]{2}-implementation#phase-[0-9]+$/;
function isComponent(name) {
  return componentNames.includes(name);
}
function listSessions(projectRoot) {
  const sessionsDir = resolve(projectRoot, ".synergy", "sessions");
  try {
    return readdirSync2(sessionsDir).filter((name) => {
      try {
        return statSync3(join2(sessionsDir, name)).isDirectory();
      } catch {
        return false;
      }
    }).sort();
  } catch {
    return [];
  }
}
function listMdxFiles(sessionDir) {
  try {
    return readdirSync2(sessionDir).filter((f) => /\.mdx$/i.test(f)).sort().map((f) => join2(sessionDir, f));
  } catch {
    return [];
  }
}
function buildInventory(parsed) {
  const headings = {};
  const files = [];
  for (const spec of parsed) {
    headings[spec.slug] = spec.headingSlugs;
    files.push(spec.slug);
  }
  return { headings, files };
}
function resolveLegacyFileRef(target, inventory) {
  const [slug, anchor] = target.split("#");
  if (!slug) return { ok: false, reason: "CrossRef `to` is empty" };
  if (!(slug in inventory.headings)) {
    return { ok: false, reason: `Unknown spec slug "${slug}"` };
  }
  if (anchor && !inventory.headings[slug].has(anchor)) {
    return { ok: false, reason: `Unknown anchor "${anchor}" in spec "${slug}"` };
  }
  return { ok: true };
}
function resolveCrossRef(target, ctx) {
  if (target.startsWith(PHASE_REF_PREFIX)) {
    const result2 = resolvePhaseCrossRef(target, { phases: ctx.phases });
    if (result2.ok) return { ok: true };
    return { ok: false, reason: result2.reason };
  }
  const result = resolveLegacyFileRef(target, ctx.inventory);
  if (!result.ok) return result;
  if (LEGACY_PHASE_REF_RE.test(target)) {
    return {
      ok: true,
      warning: `Legacy phase CrossRef form \`${target}\` \u2014 prefer the new \`phases/<slug>\` form (e.g. \`phases/core\`) so refs survive renumbering.`
    };
  }
  return { ok: true };
}
function validateOverviewHeadings(parsed) {
  const overview = parsed.find((p) => p.slug === "00-overview");
  if (!overview) return [];
  const issues = [];
  for (const required of REQUIRED_OVERVIEW_HEADINGS) {
    if (!overview.headingSlugs.has(required)) {
      const heading = required[0].toUpperCase() + required.slice(1);
      issues.push({
        file: overview.filePath,
        severity: "error",
        message: `\`00-overview.mdx\` is missing required heading \`## ${heading}\``
      });
    }
  }
  return issues;
}
function tryParse(file) {
  try {
    return { parsed: parseSpecCached(file) };
  } catch (err) {
    const e = err;
    return {
      issue: {
        file,
        line: e.line,
        column: e.column,
        severity: "error",
        message: `Parse failed: ${e.reason ?? e.message ?? String(err)}`
      }
    };
  }
}
function parsePhases(sessionDir) {
  const phases = listPhases(sessionDir);
  const parsed = /* @__PURE__ */ new Map();
  const issues = [];
  for (const phase of phases) {
    if (phase.malformed || !phase.slug) continue;
    const specFile = join2(phase.dir, "spec.mdx");
    if (!existsSync3(specFile)) continue;
    const attempt = tryParse(specFile);
    if (attempt.issue) {
      issues.push(attempt.issue);
      continue;
    }
    if (attempt.parsed) parsed.set(phase.slug, attempt.parsed);
  }
  return { parsed, issues };
}
function validateSession(sessionDir, files = listMdxFiles(sessionDir)) {
  const issues = [];
  if (files.length === 0) {
    issues.push({
      file: sessionDir,
      severity: "warning",
      message: "Session contains no .mdx files"
    });
    return issues;
  }
  const parsed = [];
  for (const f of files) {
    const attempt = tryParse(f);
    if (attempt.issue) issues.push(attempt.issue);
    if (attempt.parsed) parsed.push(attempt.parsed);
  }
  const inventory = buildInventory(parsed);
  issues.push(...validateOverviewHeadings(parsed));
  issues.push(...validatePhaseStructure(sessionDir));
  const phaseParse = parsePhases(sessionDir);
  issues.push(...phaseParse.issues);
  const allParsed = [...parsed, ...phaseParse.parsed.values()];
  const ctx = { inventory, phases: phaseParse.parsed };
  const knownAgentNames = /* @__PURE__ */ new Set();
  for (const spec of allParsed) {
    for (const comp of spec.components) {
      if (comp.name === "AgentTree" && Array.isArray(comp.attributes.nodes)) {
        for (const n of collectAgentNames(comp.attributes.nodes)) {
          knownAgentNames.add(n);
        }
      }
    }
  }
  for (const spec of allParsed) {
    for (const comp of spec.components) {
      if (!isComponent(comp.name)) continue;
      for (const attrName of comp.unparsedAttributes) {
        issues.push({
          file: spec.filePath,
          line: comp.line,
          column: comp.column,
          component: comp.name,
          severity: "warning",
          message: `Attribute \`${attrName}\` is a non-literal expression; cannot validate against schema`
        });
      }
      if (comp.name === "Phase" && comp.attributes.id === void 0) {
        issues.push({
          file: spec.filePath,
          line: comp.line,
          column: comp.column,
          component: "Phase",
          severity: "warning",
          message: 'Phase has no `id` \u2014 add a stable slug (e.g. id="storage") so execution state survives renumbering.'
        });
      }
      const validate2 = getValidators().get(comp.name);
      const ok = validate2(comp.attributes);
      if (!ok) {
        for (const err of validate2.errors ?? []) {
          const path = err.instancePath || "(root)";
          issues.push({
            file: spec.filePath,
            line: comp.line,
            column: comp.column,
            component: comp.name,
            severity: "error",
            message: `${path} ${err.message ?? "invalid"}`
          });
        }
      }
      if (comp.name === "CrossRef") {
        const to = comp.attributes.to;
        if (typeof to === "string") {
          const result = resolveCrossRef(to, ctx);
          if (!result.ok) {
            issues.push({
              file: spec.filePath,
              line: comp.line,
              column: comp.column,
              component: "CrossRef",
              severity: "error",
              message: `CrossRef to="${to}" \u2014 ${result.reason}`
            });
          } else if (result.warning) {
            issues.push({
              file: spec.filePath,
              line: comp.line,
              column: comp.column,
              component: "CrossRef",
              severity: "warning",
              message: result.warning
            });
          }
        }
      }
      if (comp.name === "AgentTree" && Array.isArray(comp.attributes.nodes)) {
        for (const flat of flattenAgentTree(comp.attributes.nodes)) {
          if (flat.resolvedEffort === null) {
            issues.push({
              file: spec.filePath,
              line: comp.line,
              column: comp.column,
              component: "AgentTree",
              severity: "warning",
              message: `Agent \`${flat.node.name}\` has no effort and no ancestor effort to inherit \u2014 add an effort or set one on a parent.`
            });
          }
          if (flat.resolvedModel === null) {
            issues.push({
              file: spec.filePath,
              line: comp.line,
              column: comp.column,
              component: "AgentTree",
              severity: "warning",
              message: `Agent \`${flat.node.name}\` has no model \u2014 assign one (start at opus; downgrade only when bounded + verified).`
            });
          }
        }
      }
      if (comp.name === "Phase" && Array.isArray(comp.attributes.agents)) {
        const known = [...knownAgentNames];
        const hint = known.length ? ` (known agents: ${known.join(", ")})` : "";
        for (const ref of comp.attributes.agents) {
          if (typeof ref === "string" && !knownAgentNames.has(ref)) {
            issues.push({
              file: spec.filePath,
              line: comp.line,
              column: comp.column,
              component: "Phase",
              severity: "warning",
              message: `Phase references unknown agent \`${ref}\`${hint}.`
            });
          }
        }
      }
    }
  }
  const knownPhaseIds = new Set(phaseParse.parsed.keys());
  for (const spec of allParsed) {
    for (const comp of spec.components) {
      if (comp.name === "Phase" && typeof comp.attributes.id === "string") {
        knownPhaseIds.add(comp.attributes.id);
      }
    }
  }
  issues.push(...validateStateForSession(sessionDir, knownPhaseIds));
  return issues;
}
function validate(options) {
  const root = resolve(options.projectRoot);
  const sessions = options.session ? [options.session] : listSessions(root);
  const allIssues = [];
  let filesChecked = 0;
  let sessionsChecked = 0;
  for (const name of sessions) {
    const sessionDir = join2(root, ".synergy", "sessions", name);
    try {
      const stat = statSync3(sessionDir);
      if (!stat.isDirectory()) continue;
    } catch {
      allIssues.push({
        file: sessionDir,
        severity: "error",
        message: `Session "${name}" not found`
      });
      continue;
    }
    sessionsChecked++;
    const files = listMdxFiles(sessionDir);
    filesChecked += files.length;
    allIssues.push(...validateSession(sessionDir, files));
  }
  return { issues: allIssues, filesChecked, sessionsChecked };
}

// src/cli.ts
function formatLocation(file, line, column) {
  const rel = file.replace(`${process.cwd()}/`, "");
  if (line && column) return `${rel}:${line}:${column}`;
  if (line) return `${rel}:${line}`;
  return rel;
}
function printHelp() {
  process.stdout.write(`synergy-validate \u2014 validate Synergy MDX specs

Usage:
  synergy-validate [session]       Validate one or all sessions in cwd's .synergy/
  synergy-validate --root <dir>    Validate sessions under a given project root
  synergy-validate --help          Show this help

Exit codes:
  0  no errors (warnings may be present)
  1  validation errors
  2  invocation error
`);
}
function parseArgs(argv) {
  const args2 = { root: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args2.help = true;
    } else if (arg === "--root") {
      const next = argv[++i];
      if (!next) {
        process.stderr.write("Error: --root requires a directory argument\n");
        process.exit(2);
      }
      args2.root = resolve2(next);
    } else if (!arg.startsWith("-")) {
      args2.session = arg;
    } else {
      process.stderr.write(`Error: unknown flag ${arg}
`);
      process.exit(2);
    }
  }
  return args2;
}
var args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
var report = validate({ projectRoot: args.root, session: args.session });
var errors = report.issues.filter((i) => i.severity === "error");
var warnings = report.issues.filter((i) => i.severity === "warning");
for (const issue of report.issues) {
  const tag = issue.severity === "error" ? red("error") : yellow("warn");
  const loc = formatLocation(issue.file, issue.line, issue.column);
  const comp = issue.component ? dim(`[${issue.component}] `) : "";
  process.stdout.write(`${tag} ${dim(loc)}
  ${comp}${issue.message}
`);
}
var summary = `${bold(`${report.sessionsChecked} session(s)`)}, ${report.filesChecked} file(s), ${errors.length} error(s), ${warnings.length} warning(s)`;
process.stdout.write(`
${errors.length === 0 ? green("\u2713") : red("\u2717")} ${summary}
`);
process.exit(errors.length > 0 ? 1 : 0);
//# sourceMappingURL=cli.js.map