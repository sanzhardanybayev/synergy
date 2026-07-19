import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as previewRuntimeExports from './preview-runtime.js';
import {
  type PreviewRuntimeState,
  deriveLoopbackOrigin,
  deriveProjectId,
  readPreviewRuntime,
  removeOwnedPreviewRuntime,
  writePreviewRuntime,
} from './preview-runtime.js';

const INSTANCE_ID = 'e104e4ae-4491-4c74-aa4b-d36d0491bb1c';

function createRuntimeState(overrides: Partial<PreviewRuntimeState> = {}): PreviewRuntimeState {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    state: 'ready',
    instanceId: INSTANCE_ID,
    projectId: 'sha256:project-id',
    pid: 12345,
    host: '127.0.0.1',
    port: 4322,
    origin: 'http://127.0.0.1:4322',
    preferredPort: 4321,
    strictPort: false,
    startedAt: '2026-07-19T16:00:00.000Z',
    controlToken: 'a'.repeat(64),
    toolVersion: '0.12.1',
    ...overrides,
  };
}

describe('preview runtime', () => {
  let tempDir: string;
  let runtimePath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `synergy-preview-runtime-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    runtimePath = join(tempDir, 'preview.runtime.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('derives a stable SHA-256 project id from the canonical root', () => {
    const canonicalRoot = '/workspace/food-tracker';
    const expectedHash = createHash('sha256').update(canonicalRoot).digest('hex');

    expect(deriveProjectId(canonicalRoot)).toBe(`sha256:${expectedHash}`);
  });

  it('generates distinct canonical 256-bit control tokens', () => {
    const generator =
      'generateControlToken' in previewRuntimeExports
        ? previewRuntimeExports.generateControlToken
        : undefined;

    expect(generator).toBeTypeOf('function');
    if (typeof generator !== 'function') return;

    const firstToken: unknown = generator();
    const secondToken: unknown = generator();
    expect(firstToken).toMatch(/^[0-9a-f]{64}$/);
    expect(secondToken).toMatch(/^[0-9a-f]{64}$/);
    expect(secondToken).not.toBe(firstToken);
  });

  it.each([1, 65_535])('derives a fixed loopback origin for valid port %i', (port) => {
    expect(deriveLoopbackOrigin(port)).toBe(`http://127.0.0.1:${port}`);
  });

  it.each([0, -1, 65_536, 1.5, Number.NaN])('rejects invalid port %p', (port) => {
    expect(() => deriveLoopbackOrigin(port)).toThrow();
  });

  it('reads a runtime record only when every persisted field is valid', () => {
    const state = createRuntimeState();
    writeFileSync(runtimePath, JSON.stringify(state));

    expect(readPreviewRuntime(runtimePath)).toEqual(state);
  });

  it('rejects malformed JSON and an invalid schema version', () => {
    writeFileSync(runtimePath, '{not-json');
    expect(readPreviewRuntime(runtimePath)).toBeNull();

    writeFileSync(runtimePath, JSON.stringify({ ...createRuntimeState(), schemaVersion: 2 }));
    expect(readPreviewRuntime(runtimePath)).toBeNull();
  });

  it.each([
    ['protocolVersion', 2],
    ['state', 'starting'],
    ['instanceId', ''],
    ['projectId', ''],
    ['pid', 0],
    ['host', 'localhost'],
    ['port', 0],
    ['preferredPort', 65_536],
    ['strictPort', 'false'],
    ['startedAt', 'not-a-date'],
    ['controlToken', ''],
    ['toolVersion', ''],
  ])('rejects an invalid %s field', (field, value) => {
    writeFileSync(runtimePath, JSON.stringify({ ...createRuntimeState(), [field]: value }));

    expect(readPreviewRuntime(runtimePath)).toBeNull();
  });

  it.each(['random-256-bit-token', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)])(
    'rejects a non-canonical control token %p',
    (controlToken) => {
      writeFileSync(runtimePath, JSON.stringify(createRuntimeState({ controlToken })));

      expect(readPreviewRuntime(runtimePath)).toBeNull();
    },
  );

  it('rejects a persisted origin that does not match the validated loopback port', () => {
    writeFileSync(
      runtimePath,
      JSON.stringify(createRuntimeState({ origin: 'http://example.test:4322' })),
    );

    expect(readPreviewRuntime(runtimePath)).toBeNull();
  });

  it('atomically replaces the runtime record and makes the final file private', () => {
    writePreviewRuntime(
      runtimePath,
      createRuntimeState({ port: 4322, origin: 'http://127.0.0.1:4322' }),
    );
    writePreviewRuntime(
      runtimePath,
      createRuntimeState({ port: 4323, origin: 'http://127.0.0.1:4323' }),
    );

    expect(readPreviewRuntime(runtimePath)?.port).toBe(4323);
    expect(readFileSync(runtimePath, 'utf8')).toContain('4323');
    expect(statSync(runtimePath).mode & 0o777).toBe(0o600);
    expect(readdirSync(tempDir)).toEqual(['preview.runtime.json']);
  });

  it('removes a runtime record only when its instance is owned by the caller', () => {
    writePreviewRuntime(runtimePath, createRuntimeState());

    expect(removeOwnedPreviewRuntime(runtimePath, 'other-instance')).toBe(false);
    expect(existsSync(runtimePath)).toBe(true);
    expect(removeOwnedPreviewRuntime(runtimePath, INSTANCE_ID)).toBe(true);
    expect(existsSync(runtimePath)).toBe(false);
  });

  it('cannot remove instance B while an instance A cleanup waits for an in-flight writer', async () => {
    const mutationLockPath = `${runtimePath}.mutation.lock`;
    const instanceB = createRuntimeState({ instanceId: 'instance-b' });
    writePreviewRuntime(runtimePath, createRuntimeState());
    writeFileSync(mutationLockPath, 'writer owns this lock');

    const writer = spawn(
      process.execPath,
      [
        '-e',
        "const fs = require('node:fs'); const [runtime, lock, state] = process.argv.slice(1); setTimeout(() => { fs.writeFileSync(runtime, state); fs.unlinkSync(lock); }, 100);",
        runtimePath,
        mutationLockPath,
        JSON.stringify(instanceB),
      ],
      { stdio: 'ignore' },
    );
    const writerExit = once(writer, 'exit');

    expect(removeOwnedPreviewRuntime(runtimePath, INSTANCE_ID)).toBe(false);
    const [exitCode] = await writerExit;
    expect(exitCode).toBe(0);
    expect(readPreviewRuntime(runtimePath)?.instanceId).toBe('instance-b');
  });

  it('releases the mutation lock when an atomic write throws', () => {
    const invalidRuntimePath = join(tempDir, 'runtime-directory');
    const mutationLockPath = `${invalidRuntimePath}.mutation.lock`;
    mkdirSync(invalidRuntimePath);

    expect(() => writePreviewRuntime(invalidRuntimePath, createRuntimeState())).toThrow();
    expect(existsSync(mutationLockPath)).toBe(false);

    rmSync(invalidRuntimePath, { recursive: true });
    expect(() => writePreviewRuntime(invalidRuntimePath, createRuntimeState())).not.toThrow();
  });
});
