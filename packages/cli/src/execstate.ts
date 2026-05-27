import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendFinding,
  deriveProgress,
  readProgress,
  setPhaseStatus,
  setResume,
  type StatusValue,
} from '@synergy/state';
import { bold, dim, green } from 'kleur/colors';
import { resolveProjectPaths } from './paths.js';

const STATUS_VALUES: StatusValue[] = [
  'draft',
  'proposed',
  'in-progress',
  'blocked',
  'done',
  'shipped',
];

function resolveSessionDir(root: string | undefined, session: string): string {
  const paths = resolveProjectPaths(root);
  const dir = join(paths.sessionsDir, session);
  if (!existsSync(dir)) {
    throw new Error(`session "${session}" not found at ${dir}`);
  }
  return dir;
}

export interface PhaseSetArgs {
  root?: string;
  session: string;
  phaseId: string;
  status: StatusValue;
  note?: string;
}

export function phaseSet(args: PhaseSetArgs): void {
  if (!STATUS_VALUES.includes(args.status)) {
    throw new Error(`invalid status "${args.status}" — use one of: ${STATUS_VALUES.join(', ')}`);
  }
  const sessionDir = resolveSessionDir(args.root, args.session);
  setPhaseStatus(sessionDir, args.phaseId, args.status, { note: args.note });
  process.stdout.write(
    `${green('✓')} ${args.session} ${dim('›')} phase ${bold(args.phaseId)} → ${args.status}\n`,
  );
}

export interface LogArgs {
  root?: string;
  session: string;
  text: string;
  phase?: string;
  global?: boolean;
}

export function logFinding(args: LogArgs): void {
  if (!args.phase && !args.global) {
    throw new Error('a finding needs a target — pass --phase or --global');
  }
  const sessionDir = resolveSessionDir(args.root, args.session);
  appendFinding(sessionDir, args.global ? { global: true } : { phase: args.phase! }, args.text);
  const where = args.global ? 'global' : `phase ${args.phase}`;
  process.stdout.write(`${green('✓')} logged finding to ${dim(where)}\n`);
}

export interface ResumeArgs {
  root?: string;
  session: string;
  next?: string;
  note?: string;
}

export function resumeSet(args: ResumeArgs): void {
  const sessionDir = resolveSessionDir(args.root, args.session);
  setResume(sessionDir, { nextPhase: args.next, note: args.note });
  process.stdout.write(`${green('✓')} resume → ${bold(args.next ?? '(unset)')}\n`);
}

export interface ProgressArgs {
  root?: string;
  session: string;
}

/** Returns the rendered summary (also used by tests); the CLI action writes it to stdout. */
export function printProgress(args: ProgressArgs): string {
  const sessionDir = resolveSessionDir(args.root, args.session);
  const progress = readProgress(sessionDir);
  const { done, total, percent } = deriveProgress(progress);
  const lines: string[] = [];
  lines.push(`${bold(args.session)}  ${done}/${total} phases done (${percent}%)`);
  if (progress.resume.nextPhase || progress.resume.note) {
    lines.push(
      `  next: ${progress.resume.nextPhase ?? '—'}${progress.resume.note ? ` — ${progress.resume.note}` : ''}`,
    );
  }
  for (const phase of progress.phases) {
    lines.push(`  ${dim('•')} ${phase.slug}  ${phase.status}`);
  }
  if (progress.phases.length === 0) lines.push(`  ${dim('(no phases recorded yet)')}`);
  return lines.join('\n');
}
