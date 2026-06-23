import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { assertSafeSession } from './execstate.js';
import { readJsonBody, sendJson } from './http.js';

export interface ScaffoldRequest {
  session: string;
  dirs?: string[];
  files: { path: string; content: string }[];
}

/** Ensure `rel` resolves inside `base`; throw otherwise. Returns the absolute path. */
function safeJoin(base: string, rel: string): string {
  const abs = resolve(base, rel);
  const r = relative(base, abs);
  if (r.startsWith('..') || resolve(base, r) !== abs || rel.startsWith('/')) {
    throw new Error(`path escapes the session directory: ${rel}`);
  }
  return abs;
}

export function applyScaffold(sessionsDir: string, body: ScaffoldRequest): { written: string[] } {
  assertSafeSession(body.session);
  const sessionDir = join(sessionsDir, body.session);
  mkdirSync(sessionDir, { recursive: true });

  for (const d of body.dirs ?? []) {
    mkdirSync(safeJoin(sessionDir, d), { recursive: true });
  }

  const written: string[] = [];
  for (const f of body.files) {
    const abs = safeJoin(sessionDir, f.path);
    if (!existsSync(dirname(abs))) mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, 'utf8');
    written.push(f.path);
  }
  return { written };
}

function isScaffoldRequest(v: unknown): v is ScaffoldRequest {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.session !== 'string' || !Array.isArray(r.files)) return false;
  if (
    r.dirs !== undefined &&
    (!Array.isArray(r.dirs) || !r.dirs.every((d) => typeof d === 'string'))
  ) {
    return false;
  }
  return r.files.every(
    (f) =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as Record<string, unknown>).path === 'string' &&
      typeof (f as Record<string, unknown>).content === 'string',
  );
}

export async function handleScaffold(
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
  if (!isScaffoldRequest(body)) {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: 'session (string) and files ([{path,content}]) are required',
    });
    return;
  }
  try {
    sendJson(res, 200, { ok: true, ...applyScaffold(sessionsDir, body) });
  } catch (err) {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
