import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ValidationReport } from '@synergy/validator';
import cac from 'cac';
import { bold, dim, green, red, yellow } from 'kleur/colors';
import { tryDaemon } from './daemon.js';
import { handoffSet, logFinding, phaseSet, printProgress, resumeSet } from './execstate.js';
import {
  LISTENING_FILE,
  type WaitResult,
  parseDuration,
  waitForFeedback,
} from './feedback-wait.js';
import { initProject } from './init.js';
import { resolveProjectPaths } from './paths.js';
import { registerPreviewCommand } from './preview-cli.js';
import { registerReviewCommands } from './review-cli.js';

const cli = cac('synergy');

cli.help();
cli.version('0.1.0');

cli
  .command('init', 'Scaffold .synergy/ in the current directory')
  .option('--root <dir>', 'Project root (default: cwd)')
  .action((flags: { root?: string }) => {
    initProject(flags.root);
  });

registerPreviewCommand(cli);

const HEARTBEAT_MS = 30_000;

function feedbackNextStep(result: WaitResult, session: string): string {
  if (result.status === 'ended') {
    return 'The user finished reviewing. Address any comments in this final batch (edit the referenced spec locations, then resolve or reject each comment), report back in the conversation, and do NOT re-run `synergy feedback wait` — the review session is over.';
  }
  if (result.status === 'timeout') {
    return `No feedback arrived before the timeout. Return to the conversation; re-run \`synergy feedback wait ${session}\` only when the user says they are reviewing again.`;
  }
  return `Address each comment: edit the referenced spec location, then resolve or reject the comment (POST /api/feedback/resolve-batch when the preview is up, frontmatter edit otherwise). After resolving, re-run \`synergy feedback wait ${session}\` to keep listening — the user sees your resolutions live.`;
}

cli
  .command('feedback <action> <session>', 'Wait for review comments (action: wait)')
  .option('--root <dir>', 'Project root (default: cwd)')
  .option('--for <duration>', 'Bounded wait, e.g. 90s, 10m, 1h (default: wait indefinitely)')
  .action(async (action: string, session: string, flags: { root?: string; for?: string }) => {
    if (action !== 'wait') {
      process.stderr.write(`${red('Error:')} unknown feedback action "${action}" — use wait\n`);
      process.exit(2);
    }
    let timeoutMs: number | undefined;
    try {
      timeoutMs = flags.for ? parseDuration(flags.for) : undefined;
    } catch (err) {
      process.stderr.write(`${red('Error:')} ${(err as Error).message}\n`);
      process.exit(2);
    }
    if (session.includes('..') || session.includes('/') || session.includes('\\')) {
      process.stderr.write(`${red('Error:')} session must be a single directory name\n`);
      process.exit(2);
    }
    const { feedbackDir } = resolveProjectPaths(flags.root);

    // The indefinite wait looks hung from the agent's side: stdout stays empty
    // until the final JSON. Banner + heartbeat on stderr keep the harness (and
    // a curious human) informed without polluting the JSON channel.
    process.stderr.write(
      `${dim('[synergy]')} Waiting for review comments on ${bold(session)}. Stays silent until the user queues a comment or clicks "Done reviewing" — leave it running.\n${dim('[synergy]')} If this gets killed, re-run \`synergy feedback wait ${session}\` — comments persist on disk and are never lost.\n`,
    );
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      process.stderr.write(`${dim(`[synergy] still waiting (${elapsed}s elapsed)…`)}\n`);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const onSignal = (signal: NodeJS.Signals) => {
      // process.exit skips waitForFeedback's cleanup — drop the presence
      // marker here so the browser doesn't show a listening agent that died.
      rmSync(join(feedbackDir, session, LISTENING_FILE), { force: true });
      process.stderr.write(
        `\n${dim('[synergy]')} Wait interrupted. Re-run \`synergy feedback wait ${session}\` to resume; queued comments persist.\n`,
      );
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    const result = await waitForFeedback({ feedbackDir, session, timeoutMs });
    clearInterval(heartbeat);
    process.stdout.write(
      `${JSON.stringify({ ...result, next_step: feedbackNextStep(result, session) }, null, 2)}\n`,
    );
  });

cli
  .command('validate [session]', 'Validate one or all sessions')
  .option('--root <dir>', 'Project root (default: cwd)')
  .action(async (session: string | undefined, flags: { root?: string }) => {
    const projectRoot = resolve(flags.root ?? process.cwd());
    // Prefer the warm preview daemon (incremental, cached) when it's running;
    // otherwise lazy-load the validator and run it in-process.
    const query = session ? `?session=${encodeURIComponent(session)}` : '';
    let report: ValidationReport | null = null;
    try {
      const fromDaemon = await tryDaemon(flags.root, 'GET', `/api/validate${query}`);
      // Only trust a well-formed report; anything else falls back in-process.
      if (fromDaemon && Array.isArray((fromDaemon as ValidationReport).issues)) {
        report = fromDaemon as ValidationReport;
      }
    } catch {
      // Daemon is up but errored — fall back to the in-process validator below.
    }
    if (!report) {
      const { validate } = await import('@synergy/validator');
      report = validate({ projectRoot, session });
    }
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
    async (
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
        const viaDaemon = await tryDaemon(flags.root, 'POST', '/api/phase', {
          session,
          phaseId,
          status,
          note: flags.note,
        });
        if (viaDaemon) {
          process.stdout.write(
            `${green('✓')} ${session} ${dim('›')} phase ${bold(phaseId)} → ${status}\n`,
          );
        } else {
          phaseSet({
            root: flags.root,
            session,
            phaseId,
            status: status as never,
            note: flags.note,
          });
        }
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
    async (
      session: string,
      text: string,
      flags: { root?: string; phase?: string; global?: boolean },
    ) => {
      try {
        const viaDaemon = await tryDaemon(flags.root, 'POST', '/api/log', {
          session,
          text,
          phase: flags.phase,
          global: flags.global,
        });
        if (viaDaemon) {
          process.stdout.write(
            `${green('✓')} logged finding to ${dim(flags.global ? 'global' : `phase ${flags.phase}`)}\n`,
          );
        } else {
          logFinding({ root: flags.root, session, text, phase: flags.phase, global: flags.global });
        }
      } catch (err) {
        process.stderr.write(`${red('Error:')} ${(err as Error).message}\n`);
        process.exit(1);
      }
    },
  );

cli
  .command('continue <session>', 'Set the resume pointer (where a fresh agent should start)')
  .option('--root <dir>', 'Project root (default: cwd)')
  .option('--next <phaseId>', 'Phase slug to resume from')
  .option('--note <text>', 'Free-text start-here note')
  .action(async (session: string, flags: { root?: string; next?: string; note?: string }) => {
    try {
      const viaDaemon = await tryDaemon(flags.root, 'POST', '/api/resume', {
        session,
        next: flags.next,
        note: flags.note,
      });
      if (viaDaemon) {
        process.stdout.write(`${green('✓')} resume → ${bold(flags.next ?? '(unset)')}\n`);
      } else {
        resumeSet({ root: flags.root, session, next: flags.next, note: flags.note });
      }
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

cli
  .command('handoff <session>', 'Write the KT handoff baton (.state/handoff.md) + resume pointer')
  .option('--root <dir>', 'Project root (default: cwd)')
  .option('--next <phaseId>', 'Phase slug the next agent should resume from')
  .option('--body <text>', 'Handoff markdown body (inline)')
  .option('--body-file <path>', 'Read the handoff markdown body from a file')
  .action(
    async (
      session: string,
      flags: { root?: string; next?: string; body?: string; bodyFile?: string },
    ) => {
      try {
        const body = flags.bodyFile ? readFileSync(flags.bodyFile, 'utf8') : (flags.body ?? '');
        if (!body.trim()) {
          process.stderr.write(`${red('Error:')} handoff needs --body or --body-file\n`);
          process.exit(1);
        }
        const viaDaemon = await tryDaemon(flags.root, 'POST', '/api/handoff', {
          session,
          body,
          next: flags.next,
        });
        if (viaDaemon) {
          process.stdout.write(`${green('✓')} handoff written → ${dim('.state/handoff.md')}\n`);
        } else {
          handoffSet({ root: flags.root, session, body, next: flags.next });
        }
      } catch (err) {
        process.stderr.write(`${red('Error:')} ${(err as Error).message}\n`);
        process.exit(1);
      }
    },
  );

registerReviewCommands(cli);

cli.parse();
