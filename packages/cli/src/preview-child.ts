import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { type InlineConfig, createServer } from 'vite';

export type PreviewChildMessage =
  | { type: 'ready'; instanceId: string; pid: number; port: number; listenMs: number }
  | { type: 'failed'; instanceId: string; phase: string; message: string }
  | { type: 'committed'; instanceId: string };

export interface PreviewChildServer {
  httpServer: { address(): AddressInfo | string | null } | null;
  listen(): Promise<unknown>;
  close(): Promise<void>;
}

export interface PreviewChildDependencies {
  env: Readonly<Record<string, string | undefined>>;
  pid: number;
  createServer(config: InlineConfig): Promise<PreviewChildServer>;
  resolvePreviewDirectory(): string;
  now(): number;
  send(message: PreviewChildMessage): void;
  onSigterm(listener: () => void): () => void;
  onParentMessage(listener: (message: unknown) => void): () => void;
  onDisconnect(listener: () => void): () => void;
  setExitCode(code: number): void;
  logError(message: string, error: unknown): void;
}

const FALLBACK_INSTANCE_ID = 'unconfigured';

function readRequiredEnvironment(env: PreviewChildDependencies['env'], name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`Missing ${name}`);
  return value;
}

function readPort(env: PreviewChildDependencies['env']): number {
  const rawPort = readRequiredEnvironment(env, 'SYNERGY_PORT');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid SYNERGY_PORT: ${rawPort}`);
  }
  return port;
}

function readStrictPort(env: PreviewChildDependencies['env']): boolean {
  const value = readRequiredEnvironment(env, 'SYNERGY_STRICT_PORT');
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid SYNERGY_STRICT_PORT: ${value}`);
}

function getListeningPort(server: PreviewChildServer): number {
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('Vite did not expose a TCP listening address');
  }
  return address.port;
}

export async function runPreviewChild(dependencies: PreviewChildDependencies): Promise<number> {
  let instanceId = FALLBACK_INSTANCE_ID;
  let phase = 'configure';
  let hasSentOutcome = false;
  let isReady = false;
  let isCommitted = false;
  let isTerminationRequested = false;
  let viteServer: PreviewChildServer | null = null;
  let closePromise: Promise<void> | null = null;

  const sendMessage = (message: PreviewChildMessage): void => {
    if (message.type !== 'committed') {
      if (hasSentOutcome) return;
      hasSentOutcome = true;
    }
    dependencies.send(message);
  };

  const closeServer = async (): Promise<void> => {
    if (viteServer === null) return;
    closePromise ??= viteServer.close();
    await closePromise;
  };

  const removeSigtermListener = dependencies.onSigterm(() => {
    isTerminationRequested = true;
    if (!isReady) {
      dependencies.setExitCode(1);
      sendMessage({
        type: 'failed',
        instanceId,
        phase,
        message: `Received SIGTERM before preview readiness during ${phase}`,
      });
    }
    void closeServer().catch((error: unknown) => {
      dependencies.logError('Failed to close the Synergy preview server:', error);
      dependencies.setExitCode(1);
    });
  });
  const removeParentMessageListener = dependencies.onParentMessage((message) => {
    if (
      !isReady ||
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      message.type !== 'commit' ||
      !('instanceId' in message) ||
      message.instanceId !== instanceId
    ) {
      return;
    }
    isCommitted = true;
    sendMessage({ type: 'committed', instanceId });
  });
  const removeDisconnectListener = dependencies.onDisconnect(() => {
    if (isCommitted) return;
    isTerminationRequested = true;
    dependencies.setExitCode(1);
    void closeServer().catch((error: unknown) => {
      dependencies.logError('Failed to close the orphaned Synergy preview server:', error);
    });
  });
  const removeLifecycleListeners = (): void => {
    removeSigtermListener();
    removeParentMessageListener();
    removeDisconnectListener();
  };

  try {
    instanceId = readRequiredEnvironment(dependencies.env, 'SYNERGY_INSTANCE_ID');
    readRequiredEnvironment(dependencies.env, 'SYNERGY_PROJECT_ROOT');
    readRequiredEnvironment(dependencies.env, 'SYNERGY_SESSIONS_DIR');
    readRequiredEnvironment(dependencies.env, 'SYNERGY_PROJECT_ID');
    readRequiredEnvironment(dependencies.env, 'SYNERGY_CONTROL_TOKEN');
    const port = readPort(dependencies.env);
    const strictPort = readStrictPort(dependencies.env);
    const previewDirectory = dependencies.resolvePreviewDirectory();
    if (isTerminationRequested) {
      removeLifecycleListeners();
      return 1;
    }

    viteServer = await dependencies.createServer({
      configFile: resolve(previewDirectory, 'vite.config.ts'),
      root: previewDirectory,
      server: {
        host: '127.0.0.1',
        port,
        strictPort,
      },
    });
    if (isTerminationRequested) {
      await closeServer();
      removeLifecycleListeners();
      return 1;
    }

    phase = 'listen';
    const listenStartedAt = dependencies.now();
    await viteServer.listen();
    if (isTerminationRequested) {
      await closeServer();
      removeLifecycleListeners();
      return 1;
    }
    const actualPort = getListeningPort(viteServer);
    const listenMs = dependencies.now() - listenStartedAt;

    isReady = true;
    sendMessage({ type: 'ready', instanceId, pid: dependencies.pid, port: actualPort, listenMs });
    return 0;
  } catch (error) {
    sendMessage({
      type: 'failed',
      instanceId,
      phase,
      message: error instanceof Error ? error.message : String(error),
    });
    await closeServer().catch((closeError: unknown) => {
      dependencies.logError('Failed to clean up the Synergy preview server:', closeError);
    });
    removeLifecycleListeners();
    return 1;
  }
}

function createProductionDependencies(): PreviewChildDependencies {
  const require = createRequire(import.meta.url);
  return {
    env: process.env,
    pid: process.pid,
    createServer,
    resolvePreviewDirectory: () => dirname(require.resolve('@synergy/preview/package.json')),
    now: () => performance.now(),
    send: (message) => process.send?.(message),
    onSigterm(listener) {
      process.once('SIGTERM', listener);
      return () => process.removeListener('SIGTERM', listener);
    },
    onParentMessage(listener) {
      process.on('message', listener);
      return () => process.removeListener('message', listener);
    },
    onDisconnect(listener) {
      process.once('disconnect', listener);
      return () => process.removeListener('disconnect', listener);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
    logError: (message, error) => console.error(message, error),
  };
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  void runPreviewChild(createProductionDependencies()).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
