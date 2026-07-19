import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  type PreviewChildDependencies,
  type PreviewChildMessage,
  type PreviewChildServer,
  runPreviewChild,
} from './preview-child.js';

const VALID_ENV = {
  SYNERGY_INSTANCE_ID: 'instance-1',
  SYNERGY_PROJECT_ROOT: '/project',
  SYNERGY_SESSIONS_DIR: '/project/.synergy/sessions',
  SYNERGY_PROJECT_ID: 'sha256:project-1',
  SYNERGY_CONTROL_TOKEN: '0123456789abcdef0123456789abcdef',
  SYNERGY_PORT: '4321',
  SYNERGY_STRICT_PORT: 'false',
} as const;

interface LauncherHarness {
  dependencies: PreviewChildDependencies;
  messages: PreviewChildMessage[];
  server: PreviewChildServer;
  listen: ReturnType<typeof vi.fn<PreviewChildServer['listen']>>;
  close: ReturnType<typeof vi.fn<PreviewChildServer['close']>>;
  createServer: ReturnType<typeof vi.fn<PreviewChildDependencies['createServer']>>;
  emitSigterm(): void;
}

function createHarness(
  env: Readonly<Record<string, string | undefined>> = VALID_ENV,
): LauncherHarness {
  let sigtermListener: (() => void) | undefined;
  const messages: PreviewChildMessage[] = [];
  const listen = vi.fn<PreviewChildServer['listen']>().mockResolvedValue(undefined);
  const close = vi.fn<PreviewChildServer['close']>().mockResolvedValue(undefined);
  const address: AddressInfo = { address: '127.0.0.1', family: 'IPv4', port: 4322 };
  const server: PreviewChildServer = {
    httpServer: { address: () => address },
    listen,
    close,
  };
  const createServer = vi.fn<PreviewChildDependencies['createServer']>().mockResolvedValue(server);
  const dependencies: PreviewChildDependencies = {
    env,
    pid: 1234,
    createServer,
    resolvePreviewDirectory: () => '/preview',
    now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125),
    send: (message) => messages.push(message),
    onSigterm(listener) {
      sigtermListener = listener;
      return () => {
        if (sigtermListener === listener) sigtermListener = undefined;
      };
    },
    setExitCode: vi.fn(),
    logError: vi.fn(),
  };

  return {
    dependencies,
    messages,
    server,
    listen,
    close,
    createServer,
    emitSigterm() {
      sigtermListener?.();
    },
  };
}

describe('runPreviewChild', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('fails before creating Vite when the instance identity is %s', async (_label, instanceId) => {
    const harness = createHarness({ ...VALID_ENV, SYNERGY_INSTANCE_ID: instanceId });

    const exitCode = await runPreviewChild(harness.dependencies);

    expect(exitCode).toBe(1);
    expect(harness.createServer).not.toHaveBeenCalled();
    expect(harness.messages).toEqual([
      {
        type: 'failed',
        instanceId: 'unconfigured',
        phase: 'configure',
        message: 'Missing SYNERGY_INSTANCE_ID',
      },
    ]);
  });

  it('sends one failed message and closes when SIGTERM lands after createServer', async () => {
    const harness = createHarness();
    harness.createServer.mockImplementation(async () => {
      harness.emitSigterm();
      return harness.server;
    });

    const exitCode = await runPreviewChild(harness.dependencies);

    expect(exitCode).toBe(1);
    expect(harness.listen).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.messages).toEqual([
      {
        type: 'failed',
        instanceId: VALID_ENV.SYNERGY_INSTANCE_ID,
        phase: 'configure',
        message: 'Received SIGTERM before preview readiness during configure',
      },
    ]);
  });

  it('sends one failed message and closes when SIGTERM lands after listen but before ready', async () => {
    const harness = createHarness();
    harness.listen.mockImplementation(async () => {
      harness.emitSigterm();
    });

    const exitCode = await runPreviewChild(harness.dependencies);

    expect(exitCode).toBe(1);
    expect(harness.listen).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.messages).toEqual([
      {
        type: 'failed',
        instanceId: VALID_ENV.SYNERGY_INSTANCE_ID,
        phase: 'listen',
        message: 'Received SIGTERM before preview readiness during listen',
      },
    ]);
  });

  it('reports the actual listening port exactly once on success', async () => {
    const harness = createHarness();

    const exitCode = await runPreviewChild(harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.messages).toEqual([
      {
        type: 'ready',
        instanceId: VALID_ENV.SYNERGY_INSTANCE_ID,
        pid: 1234,
        port: 4322,
        listenMs: 25,
      },
    ]);
  });
});
