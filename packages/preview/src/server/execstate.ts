import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  type StatusValue,
  appendFinding,
  setPhaseStatus,
  setResume,
  writeHandoff,
} from '@synergy/state';
import { readJsonBody, sendJson } from './http.js';

const STATUS_VALUES: StatusValue[] = [
  'draft',
  'proposed',
  'in-progress',
  'blocked',
  'done',
  'shipped',
];

/** Reject session names that could escape the sessions directory. */
export function assertSafeSession(session: string): void {
  if (
    !session ||
    session.includes('/') ||
    session.includes('\\') ||
    session.includes('..') ||
    session.includes('\0')
  ) {
    throw new Error(`invalid session name: ${session}`);
  }
}

export function applyPhaseSet(
  sessionsDir: string,
  body: { session: string; phaseId: string; status: StatusValue; note?: string },
): void {
  assertSafeSession(body.session);
  if (!STATUS_VALUES.includes(body.status)) {
    throw new Error(`invalid status "${body.status}" — use one of: ${STATUS_VALUES.join(', ')}`);
  }
  setPhaseStatus(join(sessionsDir, body.session), body.phaseId, body.status, { note: body.note });
}

export function applyLog(
  sessionsDir: string,
  body: { session: string; text: string; phase?: string; global?: boolean },
): void {
  assertSafeSession(body.session);
  if (!body.phase && !body.global) {
    throw new Error('a finding needs a target — pass --phase or --global');
  }
  appendFinding(
    join(sessionsDir, body.session),
    body.global ? { global: true } : { phase: body.phase! },
    body.text,
  );
}

export function applyResume(
  sessionsDir: string,
  body: { session: string; next?: string; note?: string },
): void {
  assertSafeSession(body.session);
  setResume(join(sessionsDir, body.session), { nextPhase: body.next, note: body.note });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export async function handlePhase(
  req: IncomingMessage,
  res: ServerResponse,
  sessionsDir: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  if (
    !isRecord(body) ||
    typeof body.session !== 'string' ||
    typeof body.phaseId !== 'string' ||
    typeof body.status !== 'string'
  ) {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: 'session, phaseId, status are required strings',
    });
    return;
  }
  try {
    applyPhaseSet(sessionsDir, {
      session: body.session,
      phaseId: body.phaseId,
      status: body.status as StatusValue,
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function handleLog(
  req: IncomingMessage,
  res: ServerResponse,
  sessionsDir: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  if (!isRecord(body) || typeof body.session !== 'string' || typeof body.text !== 'string') {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: 'session and text are required strings',
    });
    return;
  }
  try {
    applyLog(sessionsDir, {
      session: body.session,
      text: body.text,
      phase: typeof body.phase === 'string' ? body.phase : undefined,
      global: body.global === true,
    });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function handleResume(
  req: IncomingMessage,
  res: ServerResponse,
  sessionsDir: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  if (!isRecord(body) || typeof body.session !== 'string') {
    sendJson(res, 400, { error: 'bad_request', detail: 'session is a required string' });
    return;
  }
  try {
    applyResume(sessionsDir, {
      session: body.session,
      next: typeof body.next === 'string' ? body.next : undefined,
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

export function applyHandoff(
  sessionsDir: string,
  body: { session: string; body: string; next?: string },
): void {
  assertSafeSession(body.session);
  const sessionDir = join(sessionsDir, body.session);
  writeHandoff(sessionDir, body.body);
  setResume(sessionDir, {
    nextPhase: body.next,
    note: `See .state/handoff.md (captured ${new Date().toISOString()})`,
  });
}

export async function handleHandoff(
  req: IncomingMessage,
  res: ServerResponse,
  sessionsDir: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  if (!isRecord(body) || typeof body.session !== 'string' || typeof body.body !== 'string') {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: 'session and body are required strings',
    });
    return;
  }
  try {
    applyHandoff(sessionsDir, {
      session: body.session,
      body: body.body,
      next: typeof body.next === 'string' ? body.next : undefined,
    });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
