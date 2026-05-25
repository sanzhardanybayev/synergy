import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleActiveSession } from '../../src/server/active-session.js';
import { makeMockReq, makeMockRes, makeTempDir } from './helpers.js';

async function callActiveSession(synergyDir: string, body: unknown) {
  const req = makeMockReq({ method: 'POST', url: '/api/active-session', body });
  const { res, result } = makeMockRes();
  await handleActiveSession(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    synergyDir,
  );
  return result();
}

describe('handleActiveSession', () => {
  let temp: ReturnType<typeof makeTempDir>;

  afterEach(() => temp?.cleanup());

  it('writes .synergy/active-session atomically with lastSeen', async () => {
    temp = makeTempDir({});
    const synergyDir = join(temp.dir, '.synergy');

    const before = new Date().toISOString();
    const r = await callActiveSession(synergyDir, { session: '2026-05-25-my-feature' });
    const after = new Date().toISOString();

    expect(r.statusCode).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body.ok).toBe(true);

    const filePath = join(synergyDir, 'active-session');
    expect(existsSync(filePath)).toBe(true);
    const data = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(data.session).toBe('2026-05-25-my-feature');
    expect(typeof data.lastSeen).toBe('string');
    // lastSeen is within the test window
    expect((data.lastSeen as string) >= before).toBe(true);
    expect((data.lastSeen as string) <= after).toBe(true);
  });

  it('overwrites existing active-session file', async () => {
    temp = makeTempDir({});
    const synergyDir = join(temp.dir, '.synergy');

    await callActiveSession(synergyDir, { session: 'first-session' });
    const r = await callActiveSession(synergyDir, { session: 'second-session' });

    expect(r.statusCode).toBe(200);
    const filePath = join(synergyDir, 'active-session');
    const data = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(data.session).toBe('second-session');
  });

  it('rejects session with forward slash', async () => {
    temp = makeTempDir({});
    const synergyDir = join(temp.dir, '.synergy');
    const r = await callActiveSession(synergyDir, { session: 'foo/bar' });
    expect(r.statusCode).toBe(400);
    const body = r.json as Record<string, unknown>;
    expect(body.error).toBe('bad_session');
  });

  it('rejects session with double-dot traversal', async () => {
    temp = makeTempDir({});
    const synergyDir = join(temp.dir, '.synergy');
    const r = await callActiveSession(synergyDir, { session: '..evil' });
    expect(r.statusCode).toBe(400);
    expect((r.json as Record<string, unknown>).error).toBe('bad_session');
  });

  it('returns 400 on empty session string', async () => {
    temp = makeTempDir({});
    const synergyDir = join(temp.dir, '.synergy');
    const r = await callActiveSession(synergyDir, { session: '' });
    expect(r.statusCode).toBe(400);
  });

  it('returns 400 on missing body fields', async () => {
    temp = makeTempDir({});
    const synergyDir = join(temp.dir, '.synergy');
    const r = await callActiveSession(synergyDir, { other: 'value' });
    expect(r.statusCode).toBe(400);
  });
});
