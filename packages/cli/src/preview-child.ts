import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { type ViteDevServer, createServer } from 'vite';

type PreviewChildMessage =
  | { type: 'ready'; instanceId: string; pid: number; port: number; listenMs: number }
  | { type: 'failed'; instanceId: string; phase: string; message: string };

const require = createRequire(import.meta.url);
let hasSentMessage = false;
let viteServer: ViteDevServer | null = null;
let closePromise: Promise<void> | null = null;
let isTerminationRequested = false;

function sendMessage(message: PreviewChildMessage): void {
  if (hasSentMessage) return;
  hasSentMessage = true;
  process.send?.(message);
}

function readRequiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
}

function readPort(): number {
  const rawPort = readRequiredEnvironment('SYNERGY_PORT');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid SYNERGY_PORT: ${rawPort}`);
  }
  return port;
}

function readStrictPort(): boolean {
  const value = readRequiredEnvironment('SYNERGY_STRICT_PORT');
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid SYNERGY_STRICT_PORT: ${value}`);
}

function resolvePreviewDirectory(): string {
  return dirname(require.resolve('@synergy/preview/package.json'));
}

function getListeningPort(server: ViteDevServer): number {
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('Vite did not expose a TCP listening address');
  }
  return address.port;
}

async function closeServer(): Promise<void> {
  if (viteServer === null) return;
  closePromise ??= viteServer.close();
  await closePromise;
}

process.once('SIGTERM', () => {
  isTerminationRequested = true;
  void closeServer().catch((error: unknown) => {
    console.error('Failed to close the Synergy preview server:', error);
    process.exitCode = 1;
  });
});

async function main(): Promise<void> {
  const instanceId = process.env.SYNERGY_INSTANCE_ID ?? 'unknown';
  let phase = 'configure';

  try {
    readRequiredEnvironment('SYNERGY_PROJECT_ROOT');
    readRequiredEnvironment('SYNERGY_SESSIONS_DIR');
    readRequiredEnvironment('SYNERGY_PROJECT_ID');
    readRequiredEnvironment('SYNERGY_CONTROL_TOKEN');
    const port = readPort();
    const strictPort = readStrictPort();
    const previewDirectory = resolvePreviewDirectory();

    viteServer = await createServer({
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
      return;
    }

    phase = 'listen';
    const listenStartedAt = performance.now();
    await viteServer.listen();
    if (isTerminationRequested) {
      await closeServer();
      return;
    }
    const actualPort = getListeningPort(viteServer);
    const listenMs = performance.now() - listenStartedAt;

    sendMessage({ type: 'ready', instanceId, pid: process.pid, port: actualPort, listenMs });
  } catch (error) {
    sendMessage({
      type: 'failed',
      instanceId,
      phase,
      message: error instanceof Error ? error.message : String(error),
    });
    await closeServer().catch((closeError: unknown) => {
      console.error('Failed to clean up the Synergy preview server:', closeError);
    });
    process.exitCode = 1;
  }
}

void main();
