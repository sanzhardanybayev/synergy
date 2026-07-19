// src/preview-child.ts
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
var FALLBACK_INSTANCE_ID = "unconfigured";
function readRequiredEnvironment(env, name) {
  const value = env[name];
  if (value === void 0 || value.trim().length === 0) throw new Error(`Missing ${name}`);
  return value;
}
function readPort(env) {
  const rawPort = readRequiredEnvironment(env, "SYNERGY_PORT");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SYNERGY_PORT: ${rawPort}`);
  }
  return port;
}
function readStrictPort(env) {
  const value = readRequiredEnvironment(env, "SYNERGY_STRICT_PORT");
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid SYNERGY_STRICT_PORT: ${value}`);
}
function getListeningPort(server) {
  const address = server.httpServer?.address();
  if (address === null || address === void 0 || typeof address === "string") {
    throw new Error("Vite did not expose a TCP listening address");
  }
  return address.port;
}
async function runPreviewChild(dependencies) {
  let instanceId = FALLBACK_INSTANCE_ID;
  let phase = "configure";
  let hasSentMessage = false;
  let isReady = false;
  let isTerminationRequested = false;
  let viteServer = null;
  let closePromise = null;
  const sendMessage = (message) => {
    if (hasSentMessage) return;
    hasSentMessage = true;
    dependencies.send(message);
  };
  const closeServer = async () => {
    if (viteServer === null) return;
    closePromise ??= viteServer.close();
    await closePromise;
  };
  const removeSigtermListener = dependencies.onSigterm(() => {
    isTerminationRequested = true;
    if (!isReady) {
      dependencies.setExitCode(1);
      sendMessage({
        type: "failed",
        instanceId,
        phase,
        message: `Received SIGTERM before preview readiness during ${phase}`
      });
    }
    void closeServer().catch((error) => {
      dependencies.logError("Failed to close the Synergy preview server:", error);
      dependencies.setExitCode(1);
    });
  });
  try {
    instanceId = readRequiredEnvironment(dependencies.env, "SYNERGY_INSTANCE_ID");
    readRequiredEnvironment(dependencies.env, "SYNERGY_PROJECT_ROOT");
    readRequiredEnvironment(dependencies.env, "SYNERGY_SESSIONS_DIR");
    readRequiredEnvironment(dependencies.env, "SYNERGY_PROJECT_ID");
    readRequiredEnvironment(dependencies.env, "SYNERGY_CONTROL_TOKEN");
    const port = readPort(dependencies.env);
    const strictPort = readStrictPort(dependencies.env);
    const previewDirectory = dependencies.resolvePreviewDirectory();
    if (isTerminationRequested) {
      removeSigtermListener();
      return 1;
    }
    viteServer = await dependencies.createServer({
      configFile: resolve(previewDirectory, "vite.config.ts"),
      root: previewDirectory,
      server: {
        host: "127.0.0.1",
        port,
        strictPort
      }
    });
    if (isTerminationRequested) {
      await closeServer();
      removeSigtermListener();
      return 1;
    }
    phase = "listen";
    const listenStartedAt = dependencies.now();
    await viteServer.listen();
    if (isTerminationRequested) {
      await closeServer();
      removeSigtermListener();
      return 1;
    }
    const actualPort = getListeningPort(viteServer);
    const listenMs = dependencies.now() - listenStartedAt;
    isReady = true;
    sendMessage({ type: "ready", instanceId, pid: dependencies.pid, port: actualPort, listenMs });
    return 0;
  } catch (error) {
    sendMessage({
      type: "failed",
      instanceId,
      phase,
      message: error instanceof Error ? error.message : String(error)
    });
    await closeServer().catch((closeError) => {
      dependencies.logError("Failed to clean up the Synergy preview server:", closeError);
    });
    removeSigtermListener();
    return 1;
  }
}
function createProductionDependencies() {
  const require2 = createRequire(import.meta.url);
  return {
    env: process.env,
    pid: process.pid,
    createServer,
    resolvePreviewDirectory: () => dirname(require2.resolve("@synergy/preview/package.json")),
    now: () => performance.now(),
    send: (message) => process.send?.(message),
    onSigterm(listener) {
      process.once("SIGTERM", listener);
      return () => process.removeListener("SIGTERM", listener);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
    logError: (message, error) => console.error(message, error)
  };
}
var entryPath = process.argv[1];
if (entryPath !== void 0 && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  void runPreviewChild(createProductionDependencies()).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
export {
  runPreviewChild
};
//# sourceMappingURL=preview-child.js.map