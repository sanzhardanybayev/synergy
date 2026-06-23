import { resolve } from 'node:path';
import cac from 'cac';
import { bold, dim, green, red, yellow } from 'kleur/colors';
import { logFinding, phaseSet, printProgress, resumeSet } from './execstate.js';
import { initProject } from './init.js';
import { previewStart, previewStatus, previewStop, printStatus } from './preview.js';

const cli = cac('synergy');

cli.help();
cli.version('0.1.0');

cli
  .command('init', 'Scaffold .synergy/ in the current directory')
  .option('--root <dir>', 'Project root (default: cwd)')
  .action((flags: { root?: string }) => {
    initProject(flags.root);
  });

cli
  .command('preview <action>', 'Manage the preview server (start | stop | status)')
  .option('--root <dir>', 'Project root (default: cwd)')
  .option('--port <port>', 'Override port', { default: 4321 })
  .action((action: string, flags: { root?: string; port: number }) => {
    if (action === 'start') {
      previewStart({ root: flags.root, port: Number(flags.port) });
    } else if (action === 'stop') {
      previewStop(flags.root);
    } else if (action === 'status') {
      printStatus(previewStatus(flags.root, Number(flags.port)));
    } else {
      process.stderr.write(
        `${red('Error:')} unknown action "${action}" — use start | stop | status\n`,
      );
      process.exit(2);
    }
  });

cli
  .command('validate [session]', 'Validate one or all sessions')
  .option('--root <dir>', 'Project root (default: cwd)')
  .action(async (session: string | undefined, flags: { root?: string }) => {
    const projectRoot = resolve(flags.root ?? process.cwd());
    // Lazy import: only the `validate` command needs the MDX parser + Ajv schema
    // stack. Loading it here keeps init/preview/phase/log/resume/status cold-starts cheap.
    const { validate } = await import('@synergy/validator');
    const report = validate({ projectRoot, session });
    const errors = report.issues.filter((i) => i.severity === 'error');
    const warnings = report.issues.filter((i) => i.severity === 'warning');

    for (const issue of report.issues) {
      const tag = issue.severity === 'error' ? red('error') : yellow('warn');
      const loc = `${issue.file.replace(`${projectRoot}/`, '')}${issue.line ? `:${issue.line}` : ''}`;
      const comp = issue.component ? dim(`[${issue.component}] `) : '';
      process.stdout.write(`${tag} ${dim(loc)}\n  ${comp}${issue.message}\n`);
    }
    const summary = `${bold(`${report.sessionsChecked} session(s)`)}, ${report.filesChecked} file(s), ${errors.length} error(s), ${warnings.length} warning(s)`;
    process.stdout.write(`\n${errors.length === 0 ? green('✓') : red('✗')} ${summary}\n`);
    process.exit(errors.length > 0 ? 1 : 0);
  });

cli
  .command('phase <action> <session> <phaseId> [status]', 'Set a phase status (action: set)')
  .option('--root <dir>', 'Project root (default: cwd)')
  .option('--note <text>', 'Boundary note appended to the phase journal')
  .action(
    (
      action: string,
      session: string,
      phaseId: string,
      status: string | undefined,
      flags: { root?: string; note?: string },
    ) => {
      if (action !== 'set') {
        process.stderr.write(`${red('Error:')} unknown phase action "${action}" — use set\n`);
        process.exit(2);
      }
      if (!status) {
        process.stderr.write(`${red('Error:')} phase set requires a <status> argument\n`);
        process.exit(2);
      }
      try {
        phaseSet({ root: flags.root, session, phaseId, status: status as never, note: flags.note });
      } catch (err) {
        process.stderr.write(`${red('Error:')} ${(err as Error).message}\n`);
        process.exit(1);
      }
    },
  );

cli
  .command('log <session> <text>', 'Append a finding to a phase journal or the global journal')
  .option('--root <dir>', 'Project root (default: cwd)')
  .option('--phase <id>', 'Phase slug to attach the finding to')
  .option('--global', 'Record a cross-cutting finding in journal.md')
  .action(
    (session: string, text: string, flags: { root?: string; phase?: string; global?: boolean }) => {
      try {
        logFinding({ root: flags.root, session, text, phase: flags.phase, global: flags.global });
      } catch (err) {
        process.stderr.write(`${red('Error:')} ${(err as Error).message}\n`);
        process.exit(1);
      }
    },
  );

cli
  .command('resume <session>', 'Set the resume pointer (where a fresh agent should start)')
  .option('--root <dir>', 'Project root (default: cwd)')
  .option('--next <phaseId>', 'Phase slug to resume from')
  .option('--note <text>', 'Free-text start-here note')
  .action((session: string, flags: { root?: string; next?: string; note?: string }) => {
    try {
      resumeSet({ root: flags.root, session, next: flags.next, note: flags.note });
    } catch (err) {
      process.stderr.write(`${red('Error:')} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command('status <session>', 'Print the execution-state rollup for a session')
  .option('--root <dir>', 'Project root (default: cwd)')
  .action((session: string, flags: { root?: string }) => {
    try {
      process.stdout.write(`${printProgress({ root: flags.root, session })}\n`);
    } catch (err) {
      process.stderr.write(`${red('Error:')} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli.parse();
