import type { CAC } from 'cac';
import { red } from 'kleur/colors';
import { previewStart, previewStatus, previewStop, printStatus } from './preview.js';

interface PreviewCommandFlags {
  root?: string;
  port?: number | string;
  json?: boolean;
}

export interface PreviewCliDependencies {
  previewStart?: typeof previewStart;
  previewStatus?: typeof previewStatus;
  previewStop?: typeof previewStop;
  printStatus?: typeof printStatus;
}

class PreviewUsageError extends Error {}

function parsePort(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new PreviewUsageError('--port must be an integer from 1 to 65535');
  }
  return port;
}

export function registerPreviewCommand(
  cli: CAC,
  dependencyOverrides: PreviewCliDependencies = {},
): void {
  const dependencies = {
    previewStart,
    previewStatus,
    previewStop,
    printStatus,
    ...dependencyOverrides,
  };

  cli
    .command('preview <action>', 'Manage the preview server (start | stop | status)')
    .option('--root <dir>', 'Project root (default: cwd)')
    .option('--port <port>', 'Require a specific port (default: prefer 4321)')
    .option('--json', 'Print machine-readable JSON')
    .action(async (action: string, flags: PreviewCommandFlags) => {
      try {
        if (action !== 'start' && action !== 'stop' && action !== 'status') {
          throw new PreviewUsageError(`unknown action "${action}" — use start | stop | status`);
        }
        if (flags.port !== undefined && action !== 'start') {
          throw new PreviewUsageError('--port is only supported for preview start');
        }

        if (action === 'start') {
          const port = parsePort(flags.port);
          const status = await dependencies.previewStart({
            root: flags.root,
            ...(flags.json ? { quiet: true } : {}),
            ...(port === undefined ? {} : { port }),
          });
          if (flags.json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
          return;
        }
        if (action === 'stop') {
          const stopped = flags.json
            ? await dependencies.previewStop(flags.root, { quiet: true })
            : await dependencies.previewStop(flags.root);
          if (!stopped) {
            throw new Error('Preview shutdown could not be confirmed');
          }
          if (flags.json) process.stdout.write(`${JSON.stringify({ stopped: true })}\n`);
          return;
        }

        const status = await dependencies.previewStatus(flags.root);
        if (flags.json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        else dependencies.printStatus(status);
      } catch (error) {
        const exitCode = error instanceof PreviewUsageError ? 2 : 1;
        const message =
          error instanceof Error ? error.message : 'unexpected preview command failure';
        process.stderr.write(`${red('Error:')} ${message}\n`);
        process.exitCode = exitCode;
      }
    });
}
