import { resolve } from 'node:path';
import { bold, dim, green, red, yellow } from 'kleur/colors';
import { validate } from './validate.js';

function formatLocation(file: string, line?: number, column?: number): string {
  const rel = file.replace(`${process.cwd()}/`, '');
  if (line && column) return `${rel}:${line}:${column}`;
  if (line) return `${rel}:${line}`;
  return rel;
}

function printHelp() {
  process.stdout.write(`synergy-validate — validate Synergy MDX specs

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

interface CliArgs {
  session?: string;
  root: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { root: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--root') {
      const next = argv[++i];
      if (!next) {
        process.stderr.write('Error: --root requires a directory argument\n');
        process.exit(2);
      }
      args.root = resolve(next);
    } else if (!arg.startsWith('-')) {
      args.session = arg;
    } else {
      process.stderr.write(`Error: unknown flag ${arg}\n`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const report = validate({ projectRoot: args.root, session: args.session });
const errors = report.issues.filter((i) => i.severity === 'error');
const warnings = report.issues.filter((i) => i.severity === 'warning');

for (const issue of report.issues) {
  const tag = issue.severity === 'error' ? red('error') : yellow('warn');
  const loc = formatLocation(issue.file, issue.line, issue.column);
  const comp = issue.component ? dim(`[${issue.component}] `) : '';
  process.stdout.write(`${tag} ${dim(loc)}\n  ${comp}${issue.message}\n`);
}

const summary = `${bold(`${report.sessionsChecked} session(s)`)}, ${report.filesChecked} file(s), ${errors.length} error(s), ${warnings.length} warning(s)`;
process.stdout.write(
  `\n${errors.length === 0 ? green('✓') : red('✗')} ${summary}\n`,
);

process.exit(errors.length > 0 ? 1 : 0);
