export const SKILL_STAMP_RE = /<!-- synergy-version: [^>]*-->/;

/** Rewrite the first `"version": "..."` in a marketplace.json string. */
export function setMarketplaceVersion(json: string, version: string): string {
  return json.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);
}

/**
 * Rewrite the first `"version": "..."` in a package.json string (used to keep
 * packages/vscode-extension/package.json in lockstep with plugin.json).
 */
export function setPackageJsonVersion(json: string, version: string): string {
  return json.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);
}

/**
 * Update the SKILL.md `synergy-version` stamp (or insert one right after the
 * frontmatter), and keep any Step-0 `MINE="..."` literal in lockstep so the two
 * textual copies of the version never drift.
 */
export function setSkillStamp(md: string, version: string): string {
  const stamp = `<!-- synergy-version: ${version} -->`;
  let out: string;
  if (SKILL_STAMP_RE.test(md)) {
    out = md.replace(SKILL_STAMP_RE, stamp);
  } else {
    const fm = md.match(/^---\n[\s\S]*?\n---\n/);
    out = fm ? `${md.slice(0, fm[0].length)}${stamp}\n${md.slice(fm[0].length)}` : md;
  }
  // Keep the Step-0 `MINE="x"` literal (when present) matching the stamp.
  return out.replace(/MINE="[^"]*"/g, `MINE="${version}"`);
}
