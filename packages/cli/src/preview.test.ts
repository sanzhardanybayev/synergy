import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tryDaemon } from './daemon.js';
import { resolveProjectPaths } from './paths.js';
import {
  type PreviewHealth,
  type PreviewRuntimeState,
  deriveLoopbackOrigin,
  deriveProjectId,
  readPreviewRuntime,
  writePreviewRuntime,
} from './preview-runtime.js';
import {
  type PreviewChildHandle,
  type PreviewChildLaunch,
  type PreviewLifecycleDependencies,
  createPreviewLifecycle,
} from './preview.js';

const CONTROL_TOKEN = 'a'.repeat(64);
const OTHER_CONTROL_TOKEN = 'b'.repeat(64);

class FakeChild extends EventEmitter implements PreviewChildHandle {
  readonly killedSignals: NodeJS.Signals[] = [];
  readonly pid: number;
  disconnected = false;
  unrefCalled = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killedSignals.push(signal);
    return true;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  unref(): void {
    this.unrefCalled = true;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function runtimeFor(
  root: string,
  overrides: Partial<PreviewRuntimeState> = {},
): PreviewRuntimeState {
  const paths = resolveProjectPaths(root);
  const port = overrides.port ?? 4321;
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    state: 'ready',
    instanceId: 'existing-instance',
    projectId: deriveProjectId(realpathSync(paths.root)),
    pid: 31_001,
    host: '127.0.0.1',
    port,
    origin: deriveLoopbackOrigin(port),
    preferredPort: 4321,
    strictPort: false,
    startedAt: '2026-07-19T12:00:00.000Z',
    controlToken: CONTROL_TOKEN,
    toolVersion: '0.12.1',
    ...overrides,
  };
}

function healthFor(runtime: PreviewRuntimeState): PreviewHealth {
  return {
    protocolVersion: 1,
    state: 'ready',
    instanceId: runtime.instanceId,
    projectId: runtime.projectId,
    pid: runtime.pid,
    port: runtime.port,
  };
}

describe('preview lifecycle', () => {
  let tempDir: string;
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `synergy-preview-lifecycle-${Date.now()}-${Math.random()}`);
    rootA = join(tempDir, 'project-a');
    rootB = join(tempDir, 'project-b');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses 4321 as a preferred port and publishes the reachable dynamic port', async () => {
    const launches: PreviewChildLaunch[] = [];
    let expectedHealth: PreviewHealth | null = null;
    const lifecycle = createPreviewLifecycle({
      createInstanceId: () => 'instance-dynamic',
      createAttemptId: () => 'attempt-dynamic',
      createControlToken: () => CONTROL_TOKEN,
      spawnChild: (launch) => {
        launches.push(launch);
        const child = new FakeChild(30_001);
        expectedHealth = {
          protocolVersion: 1,
          state: 'ready',
          instanceId: launch.instanceId,
          projectId: launch.projectId,
          pid: child.pid,
          port: 43_222,
        };
        queueMicrotask(() => {
          child.emit('message', {
            type: 'ready',
            instanceId: launch.instanceId,
            pid: child.pid,
            port: 43_222,
            listenMs: 12,
          });
        });
        return child;
      },
      fetch: async () => jsonResponse(expectedHealth),
    });

    const status = await lifecycle.start({ root: rootA });

    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ port: 4321, strictPort: false });
    expect(status).toMatchObject({
      running: true,
      pid: 30_001,
      port: 43_222,
      origin: 'http://127.0.0.1:43222',
      instanceId: 'instance-dynamic',
    });
    expect(status.timings).toEqual({
      lockMs: expect.any(Number),
      launchMs: expect.any(Number),
      listenMs: 12,
      healthMs: expect.any(Number),
      totalMs: expect.any(Number),
    });
    expect(readPreviewRuntime(resolveProjectPaths(rootA).previewRuntimeFile)?.port).toBe(43_222);
  });

  it('rejects an occupied explicit port without printing success', async () => {
    const output: string[] = [];
    const launches: PreviewChildLaunch[] = [];
    const lifecycle = createPreviewLifecycle({
      createInstanceId: () => 'instance-strict',
      createAttemptId: () => 'attempt-strict',
      createControlToken: () => CONTROL_TOKEN,
      writeOutput: (text) => output.push(text),
      spawnChild: (launch) => {
        launches.push(launch);
        const child = new FakeChild(30_002);
        queueMicrotask(() => {
          child.emit('message', {
            type: 'failed',
            instanceId: launch.instanceId,
            phase: 'listen',
            message: 'Port 4321 is already in use',
          });
        });
        return child;
      },
      fetch: async () => {
        throw new Error('health must not be queried after child failure');
      },
    });

    await expect(lifecycle.start({ root: rootA, port: 4321 })).rejects.toThrow(
      'Port 4321 is already in use',
    );
    expect(launches[0]).toMatchObject({ port: 4321, strictPort: true });
    expect(output.join('')).not.toContain('Preview started');
    expect(existsSync(resolveProjectPaths(rootA).previewRuntimeFile)).toBe(false);
  });

  it('cancels the readiness deadline after a successful child message', async () => {
    const scheduled: unknown[] = [];
    const cancelled: unknown[] = [];
    const lifecycle = createPreviewLifecycle({
      createInstanceId: () => 'instance-cancel-timer',
      createAttemptId: () => 'attempt-cancel-timer',
      createControlToken: () => CONTROL_TOKEN,
      writeOutput: () => undefined,
      setTimer: (_callback: () => void, _milliseconds: number) => {
        const timer = {};
        scheduled.push(timer);
        return timer;
      },
      clearTimer: (timer: unknown) => cancelled.push(timer),
      spawnChild: (launch) => {
        const child = new FakeChild(30_006);
        queueMicrotask(() => {
          child.emit('message', {
            type: 'ready',
            instanceId: launch.instanceId,
            pid: child.pid,
            port: 4321,
            listenMs: 1,
          });
        });
        return child;
      },
      fetch: async () =>
        jsonResponse({
          protocolVersion: 1,
          state: 'ready',
          instanceId: 'instance-cancel-timer',
          projectId: deriveProjectId(realpathSync(rootA)),
          pid: 30_006,
          port: 4321,
        }),
    } as Partial<PreviewLifecycleDependencies> & {
      setTimer(callback: () => void, milliseconds: number): unknown;
      clearTimer(timer: unknown): void;
    });

    await lifecycle.start({ root: rootA });

    expect(scheduled).toHaveLength(1);
    expect(cancelled).toEqual(scheduled);
  });

  it.each(['instance', 'project'] as const)(
    'rejects a ready child with mismatched %s identity',
    async (mismatch) => {
      const lifecycle = createPreviewLifecycle({
        createInstanceId: () => 'expected-instance',
        createAttemptId: () => `attempt-wrong-${mismatch}`,
        createControlToken: () => CONTROL_TOKEN,
        spawnChild: (launch) => {
          const child = new FakeChild(30_003);
          queueMicrotask(() => {
            child.emit('message', {
              type: 'ready',
              instanceId: mismatch === 'instance' ? 'wrong-instance' : launch.instanceId,
              pid: child.pid,
              port: 4321,
              listenMs: 5,
            });
          });
          return child;
        },
        fetch: async () =>
          jsonResponse({
            protocolVersion: 1,
            state: 'ready',
            instanceId: 'expected-instance',
            projectId: mismatch === 'project' ? 'sha256:wrong-project' : deriveProjectId(rootA),
            pid: 30_003,
            port: 4321,
          }),
      });

      await expect(lifecycle.start({ root: rootA })).rejects.toThrow(/identity/i);
      expect(existsSync(resolveProjectPaths(rootA).previewRuntimeFile)).toBe(false);
    },
  );

  it('serializes same-project starts so both callers converge on one runtime', async () => {
    let spawnCount = 0;
    let launchedRuntime: PreviewRuntimeState | null = null;
    const lifecycle = createPreviewLifecycle({
      createInstanceId: () => 'serialized-instance',
      createAttemptId: () => `attempt-${spawnCount + 1}`,
      createControlToken: () => CONTROL_TOKEN,
      spawnChild: (launch) => {
        spawnCount += 1;
        const child = new FakeChild(30_004);
        launchedRuntime = runtimeFor(rootA, {
          instanceId: launch.instanceId,
          projectId: launch.projectId,
          pid: child.pid,
          controlToken: launch.controlToken,
        });
        setTimeout(() => {
          child.emit('message', {
            type: 'ready',
            instanceId: launch.instanceId,
            pid: child.pid,
            port: 4321,
            listenMs: 7,
          });
        }, 20);
        return child;
      },
      fetch: async () => jsonResponse(healthFor(launchedRuntime!)),
      startTimeoutMs: 1_000,
    });

    const [first, second] = await Promise.all([
      lifecycle.start({ root: rootA }),
      lifecycle.start({ root: rootA }),
    ]);

    expect(spawnCount).toBe(1);
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.pid).toBe(first.pid);
  });

  it('allows distinct project roots to launch simultaneously', async () => {
    const children: Array<{ child: FakeChild; launch: PreviewChildLaunch }> = [];
    let id = 0;
    const lifecycle = createPreviewLifecycle({
      createInstanceId: () => `instance-${++id}`,
      createAttemptId: () => `attempt-${id}`,
      createControlToken: () => (id === 1 ? CONTROL_TOKEN : OTHER_CONTROL_TOKEN),
      spawnChild: (launch) => {
        const child = new FakeChild(31_000 + children.length);
        children.push({ child, launch });
        return child;
      },
      fetch: async (url) => {
        const port = Number(new URL(String(url)).port);
        const launched = children.find((entry) => 44_000 + entry.child.pid - 31_000 === port);
        if (!launched) throw new Error(`unknown port ${port}`);
        return jsonResponse({
          protocolVersion: 1,
          state: 'ready',
          instanceId: launched.launch.instanceId,
          projectId: launched.launch.projectId,
          pid: launched.child.pid,
          port,
        });
      },
      startTimeoutMs: 1_000,
    });

    const startA = lifecycle.start({ root: rootA });
    const startB = lifecycle.start({ root: rootB });
    await vi.waitFor(() => expect(children).toHaveLength(2));
    for (const [index, entry] of children.entries()) {
      entry.child.emit('message', {
        type: 'ready',
        instanceId: entry.launch.instanceId,
        pid: entry.child.pid,
        port: 44_000 + index,
        listenMs: 3,
      });
    }

    const [statusA, statusB] = await Promise.all([startA, startB]);
    expect(statusA.projectId).not.toBe(statusB.projectId);
    expect(statusA.port).not.toBe(statusB.port);
  });

  it('reports malformed, unreachable, and identity-mismatched state as stopped', async () => {
    const paths = resolveProjectPaths(rootA);
    mkdirSync(paths.synergyDir, { recursive: true });
    const lifecycle = createPreviewLifecycle({ fetch: async () => jsonResponse({}) });

    writeFileSync(paths.previewRuntimeFile, '{malformed');
    await expect(lifecycle.status(rootA)).resolves.toMatchObject({
      running: false,
      pid: null,
      port: null,
      origin: null,
      projectId: deriveProjectId(realpathSync(rootA)),
      instanceId: null,
    });

    const runtime = runtimeFor(rootA);
    writePreviewRuntime(paths.previewRuntimeFile, runtime);
    const unreachable = createPreviewLifecycle({
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect((await unreachable.status(rootA)).running).toBe(false);

    const mismatch = createPreviewLifecycle({
      fetch: async () => jsonResponse({ ...healthFor(runtime), instanceId: 'impostor' }),
    });
    expect((await mismatch.status(rootA)).running).toBe(false);
  });

  it('stops only through authenticated HTTP after verifying runtime identity', async () => {
    const paths = resolveProjectPaths(rootA);
    mkdirSync(paths.synergyDir, { recursive: true });
    const runtime = runtimeFor(rootA);
    writePreviewRuntime(paths.previewRuntimeFile, runtime);
    const processKill = vi.fn(() => true);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let isShutdown = false;
    const lifecycle = createPreviewLifecycle({
      processKill,
      pollIntervalMs: 1,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        if (init?.method === 'POST') {
          isShutdown = true;
          return jsonResponse({ ok: true }, 202);
        }
        if (isShutdown) throw new Error('ECONNREFUSED');
        return jsonResponse(healthFor(runtime));
      },
    });

    await expect(lifecycle.stop(rootA)).resolves.toBe(true);

    expect(processKill).not.toHaveBeenCalled();
    expect(requests[1]).toMatchObject({
      url: `${runtime.origin}/api/runtime/shutdown`,
      init: {
        method: 'POST',
        headers: {
          authorization: `Bearer ${CONTROL_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ instanceId: runtime.instanceId }),
      },
    });
    expect(existsSync(paths.previewRuntimeFile)).toBe(false);
  });

  it('never stops or removes metadata for an unverified runtime', async () => {
    const paths = resolveProjectPaths(rootA);
    mkdirSync(paths.synergyDir, { recursive: true });
    const runtime = runtimeFor(rootA);
    writePreviewRuntime(paths.previewRuntimeFile, runtime);
    const processKill = vi.fn(() => true);
    const lifecycle = createPreviewLifecycle({
      processKill,
      fetch: async () => jsonResponse({ ...healthFor(runtime), projectId: 'sha256:impostor' }),
    });

    await expect(lifecycle.stop(rootA)).resolves.toBe(false);
    expect(processKill).not.toHaveBeenCalled();
    expect(readPreviewRuntime(paths.previewRuntimeFile)).toEqual(runtime);
  });

  it('removes a stale legacy PID but leaves a live unverified legacy PID untouched', async () => {
    const pathsA = resolveProjectPaths(rootA);
    const pathsB = resolveProjectPaths(rootB);
    mkdirSync(pathsA.synergyDir, { recursive: true });
    mkdirSync(pathsB.synergyDir, { recursive: true });
    writeFileSync(pathsA.previewPidFile, '41001\n');
    writeFileSync(pathsB.previewPidFile, '41002\n');
    const lifecycle = createPreviewLifecycle({
      processKill: (pid, signal) => {
        expect(signal).toBe(0);
        if (pid === 41_001) throw new Error('ESRCH');
        return true;
      },
      fetch: async () => {
        throw new Error('health should not be queried without runtime metadata');
      },
    });

    await lifecycle.status(rootA);
    await lifecycle.status(rootB);

    expect(existsSync(pathsA.previewPidFile)).toBe(false);
    expect(existsSync(pathsB.previewPidFile)).toBe(true);
  });

  it.each(['timeout', 'exit'] as const)(
    '%s failure preserves another instance state and reports only a bounded log tail',
    async (failure) => {
      const paths = resolveProjectPaths(rootA);
      const otherRuntime = runtimeFor(rootA, {
        instanceId: 'other-instance',
        pid: 39_999,
        port: 4399,
        origin: deriveLoopbackOrigin(4399),
      });
      const spawnedChildren: FakeChild[] = [];
      const lifecycle = createPreviewLifecycle({
        createInstanceId: () => 'failed-instance',
        createAttemptId: () => `attempt-${failure}`,
        createControlToken: () => CONTROL_TOKEN,
        startTimeoutMs: 35,
        pollIntervalMs: 1,
        spawnChild: () => {
          const child = new FakeChild(30_005);
          spawnedChildren.push(child);
          writeFileSync(paths.previewLogFile, `${'discarded\n'.repeat(2_000)}TAIL-MARKER\n`);
          writePreviewRuntime(paths.previewRuntimeFile, otherRuntime);
          if (failure === 'exit') {
            queueMicrotask(() => child.emit('exit', 1, null));
          }
          return child;
        },
        fetch: async () => {
          throw new Error('health should not run before ready');
        },
      });

      const error = await lifecycle.start({ root: rootA }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(failure === 'timeout' ? '10 seconds' : 'exited');
      expect((error as Error).message).toContain('TAIL-MARKER');
      expect((error as Error).message.length).toBeLessThan(9_000);
      expect(readPreviewRuntime(paths.previewRuntimeFile)).toEqual(otherRuntime);
      expect(spawnedChildren[0]?.killedSignals).toContain('SIGTERM');
      expect(existsSync(paths.previewLockFile)).toBe(false);
    },
  );

  it('does not remove matching-instance metadata that the failed attempt never published', async () => {
    const paths = resolveProjectPaths(rootA);
    const preexistingRuntime = runtimeFor(rootA, {
      instanceId: 'colliding-instance',
      pid: 39_998,
      port: 4398,
      origin: deriveLoopbackOrigin(4398),
    });
    const lifecycle = createPreviewLifecycle({
      createInstanceId: () => 'colliding-instance',
      createAttemptId: () => 'attempt-collision',
      createControlToken: () => CONTROL_TOKEN,
      writeOutput: () => undefined,
      spawnChild: () => {
        const child = new FakeChild(30_007);
        writePreviewRuntime(paths.previewRuntimeFile, preexistingRuntime);
        queueMicrotask(() => child.emit('exit', 1, null));
        return child;
      },
      fetch: async () => {
        throw new Error('health should not run before ready');
      },
    });

    await expect(lifecycle.start({ root: rootA })).rejects.toThrow('exited');

    expect(readPreviewRuntime(paths.previewRuntimeFile)).toEqual(preexistingRuntime);
  });

  it('routes daemon requests through the verified runtime origin', async () => {
    const paths = resolveProjectPaths(rootA);
    mkdirSync(paths.synergyDir, { recursive: true });
    const runtime = runtimeFor(rootA, {
      port: 45_678,
      origin: deriveLoopbackOrigin(45_678),
    });
    writePreviewRuntime(paths.previewRuntimeFile, runtime);
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.endsWith('/api/runtime/health')) return jsonResponse(healthFor(runtime));
        return jsonResponse({ ok: true });
      }),
    );

    await expect(tryDaemon(rootA, 'GET', '/api/progress?session=example')).resolves.toEqual({
      ok: true,
    });
    expect(requestedUrls).toEqual([
      'http://127.0.0.1:45678/api/runtime/health',
      'http://127.0.0.1:45678/api/progress?session=example',
    ]);
  });
});
