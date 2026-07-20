interface ValidationIssue {
    /** Absolute path to the offending file. */
    file: string;
    line?: number;
    column?: number;
    /** Component name (when known). */
    component?: string;
    message: string;
    severity: 'error' | 'warning';
}
interface SessionInventory {
    /** Map: spec slug (filename without extension) -> heading slugs found in that file. */
    headings: Record<string, Set<string>>;
    /** All spec files in the session, sorted by filename. */
    files: string[];
}
interface ValidateOptions {
    /** Root of the consumer project (where .synergy/ lives). */
    projectRoot: string;
    /** Restrict validation to a single session name; defaults to all. */
    session?: string;
}
interface ValidationReport {
    issues: ValidationIssue[];
    filesChecked: number;
    sessionsChecked: number;
}

declare function validate(options: ValidateOptions): ValidationReport;

interface ParsedComponent {
    name: string;
    attributes: Record<string, unknown>;
    /** Names of attributes that couldn't be parsed (validator will warn). */
    unparsedAttributes: string[];
    line?: number;
    column?: number;
}
interface ParsedSpec {
    /** Filename without extension. */
    slug: string;
    filePath: string;
    /** Slugs of every heading in the file (deduped per file by github-slugger). */
    headingSlugs: Set<string>;
    /** Components used in the file. */
    components: ParsedComponent[];
}
declare function parseSpec(filePath: string): ParsedSpec;

/**
 * Parse an MDX spec, reusing the previous result when the file is unchanged.
 *
 * Keyed by absolute path + `mtimeMs` + byte `size`. The size acts as a cheap
 * second signal so a same-millisecond rewrite of a different length is not
 * served stale. In a one-shot CLI process the cache is always cold (no
 * behavioral change); in the long-lived preview daemon repeated validations
 * only re-parse the files that actually changed.
 */
declare function parseSpecCached(filePath: string): ParsedSpec;
/** Empty the parse cache. */
declare function clearParseCache(): void;

interface PhaseFolder {
    /** Folder name as it appears on disk, e.g. "02-core". */
    folderName: string;
    /** Absolute path to the phase folder. */
    dir: string;
    /** Numeric prefix (parsed from `NN`), or `undefined` if malformed. */
    order: number | undefined;
    /** Kebab-case slug after the numeric prefix, or `undefined` if malformed. */
    slug: string | undefined;
    /** True when the folder name does NOT match `NN-<slug>`. */
    malformed: boolean;
}
/**
 * List `phases/*` folders under a session directory. Returns folders sorted by
 * numeric prefix (malformed entries last, in name order). Non-directory entries
 * under `phases/` are skipped. Returns `[]` if `phases/` does not exist.
 */
declare function listPhases(sessionDir: string): PhaseFolder[];

export { type ParsedComponent, type ParsedSpec, type PhaseFolder, type SessionInventory, type ValidateOptions, type ValidationIssue, type ValidationReport, clearParseCache, listPhases, parseSpec, parseSpecCached, validate };
