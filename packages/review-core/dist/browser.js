import {
  buildRemovalStrips,
  deriveRemovalRuns,
  deriveReviewReadiness,
  resolveBrowserReviewItemContext
} from "./chunk-XNYFNTV3.js";

// src/browser.ts
function stableReviewJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableReviewJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableReviewJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
export {
  buildRemovalStrips,
  deriveRemovalRuns,
  deriveReviewReadiness,
  resolveBrowserReviewItemContext,
  stableReviewJson
};
//# sourceMappingURL=browser.js.map