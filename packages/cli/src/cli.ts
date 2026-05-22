import { resolve } from 'node:path';
import { validate } from '@synergy/validator';
import cac from 'cac';
import { bold, dim, green, red, yellow } from 'kleur/colors';
import open from 'open';
import { initProject } from './init.js';
import { previewStart, previewStatus, previewStop, printStatus } from './preview.js';
import { createSpec, isSpecType, type SpecType } from './spec.js';

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
  .command('spec [title]', 'Create a new spec session')
  .option('--type <type>', 'Spec type: feature | refactor | project', { default: 'feature' })
  .option('--name <name>', 'Explicit session name (skips auto-generation)')
  .option('--root <dir>', 'Project root (default: cwd)')
  .option('--no-preview', 'Do not auto-start preview after creating')
  .option('--no-open', 'Do not auto-open browser')
  .action(
    async (
      title: string | undefined,
      flags: {
        type: string;
        name?: string;
        root?: string;
        preview?: boolean;
        open?: boolean;
      },
    ) => {
      if (!title) {
        process.stderr.write(red('Error:') + ' a title is required: `synergy spec "My feature"`\n');
        process.exit(2);
      }
      if (!isSpecType(flags.type)) {
        process.stderr.write(
          red('Error:') + ` --type must be one of: feature, refactor, project (got "${flags.type}")\n`,
        );
        process.exit(2);
      }
      const type: SpecType = flags.type;
      const result = createSpec({
        title,
        type,
        sessionName: flags.name,
        root: flags.root,
      });

      if (flags.preview !== false) {
        const status = previewStart({ root: flags.root });
        if (flags.open !== false && status.running) {
          const url = `${status.url}/s/${result.sessionName}`;
          try {
            await open(url);
            process.stdout.write(`${dim('→')} Opened ${url}\n`);
          } catch {
            process.stdout.write(`${dim('→')} Visit ${url}\n`);
          }
        }
      }
    },
  );

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
      process.stderr.write(red('Error:') + ` unknown action "${action}" — use start | stop | status\n`);
      process.exit(2);
    }
  });

cli
  .command('validate [session]', 'Validate one or all sessions')
  .option('--root <dir>', 'Project root (default: cwd)')
  .action((session: string | undefined, flags: { root?: string }) => {
    const projectRoot = resolve(flags.root ?? process.cwd());
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

cli.parse();
