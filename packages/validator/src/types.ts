export interface ValidationIssue {
  /** Absolute path to the offending file. */
  file: string;
  line?: number;
  column?: number;
  /** Component name (when known). */
  component?: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface SessionInventory {
  /** Map: spec slug (filename without extension) -> heading slugs found in that file. */
  headings: Record<string, Set<string>>;
  /** All spec files in the session, sorted by filename. */
  files: string[];
}

export interface ValidateOptions {
  /** Root of the consumer project (where .synergy/ lives). */
  projectRoot: string;
  /** Restrict validation to a single session name; defaults to all. */
  session?: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  filesChecked: number;
  sessionsChecked: number;
}
