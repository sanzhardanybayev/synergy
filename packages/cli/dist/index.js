// src/init.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { green } from "kleur/colors";

// src/paths.ts
import { resolve } from "node:path";
function resolveProjectPaths(root = process.cwd()) {
  const projectRoot = resolve(root);
  const synergyDir = resolve(projectRoot, ".synergy");
  return {
    root: projectRoot,
    synergyDir,
    sessionsDir: resolve(synergyDir, "sessions"),
    feedbackDir: resolve(synergyDir, "feedback"),
    reviewsDir: resolve(synergyDir, "reviews"),
    activeReviewFile: resolve(synergyDir, "active-review.json"),
    previewRuntimeFile: resolve(synergyDir, "preview.runtime.json"),
    previewLockFile: resolve(synergyDir, "preview.start.lock"),
    previewPidFile: resolve(synergyDir, "preview.pid"),
    previewLogFile: resolve(synergyDir, "preview.log")
  };
}
var PREVIEW_PORT = 4321;

// src/init.ts
var GITIGNORE_ENTRIES = [
  "preview.runtime.json",
  "preview.runtime.json.quarantine.*",
  ".preview.runtime.json.*.tmp",
  "preview.runtime.json.mutation.lock",
  "preview.start.lock",
  "preview.start.lock.quarantine.*",
  "preview.start.lock.owner.tmp.*",
  "preview.pid",
  "preview.log",
  "active-session",
  "review-state.json",
  "reviews/",
  "active-review.json",
  ""
];
function ensureSynergyGitignore(root = process.cwd()) {
  const paths = resolveProjectPaths(root);
  mkdirSync(paths.synergyDir, { recursive: true });
  const gitignorePath = join(paths.synergyDir, ".gitignore");
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const present = new Set(current.split(/\r?\n/u));
  const missing = GITIGNORE_ENTRIES.filter((entry) => entry.length > 0 && !present.has(entry));
  if (missing.length === 0) return gitignorePath;
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(gitignorePath, `${separator}${missing.join("\n")}
`);
  return gitignorePath;
}
function initProject(root = process.cwd()) {
  const paths = resolveProjectPaths(root);
  mkdirSync(paths.sessionsDir, { recursive: true });
  ensureSynergyGitignore(paths.root);
  process.stdout.write(`${green("\u2713")} Initialized .synergy/ in ${paths.root}
`);
  return { synergyDir: paths.synergyDir };
}

// src/preview.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import {
  constants as constants3,
  closeSync as closeSync4,
  copyFileSync as copyFileSync3,
  existsSync as existsSync2,
  fstatSync,
  mkdirSync as mkdirSync2,
  openSync as openSync4,
  readFileSync as readFileSync4,
  readSync,
  realpathSync,
  renameSync as renameSync3,
  unlinkSync as unlinkSync3
} from "node:fs";
import { dim, green as green2, yellow } from "kleur/colors";

// src/preview-lock.ts
import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  copyFileSync,
  fsyncSync,
  openSync,
  readFileSync as readFileSync2,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join as join2 } from "node:path";
var DEFAULT_DEPENDENCIES = {
  copyFileExclusive: (source, destination) => copyFileSync(source, destination, constants.COPYFILE_EXCL),
  createQuarantineId: randomUUID,
  now: () => performance.now(),
  publishOwnerRecord: (source, destination) => renameSync(source, destination),
  unlinkFile: unlinkSync,
  wallNow: Date.now,
  sleep: (milliseconds) => new Promise((resolve2) => setTimeout(resolve2, milliseconds))
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasErrorCode(error, code) {
  return isRecord(error) && error.code === code;
}
function readLockRecord(path) {
  try {
    const value = JSON.parse(readFileSync2(path, "utf8"));
    if (!isRecord(value) || typeof value.attemptId !== "string" || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.createdAt !== "string") {
      return null;
    }
    const leaseExpiresAt = typeof value.leaseExpiresAt === "string" && Number.isFinite(Date.parse(value.leaseExpiresAt)) ? value.leaseExpiresAt : null;
    return {
      attemptId: value.attemptId,
      pid: value.pid,
      createdAt: value.createdAt,
      leaseExpiresAt
    };
  } catch {
    return null;
  }
}
function quarantinePath(path, attemptId, dependencies) {
  return `${path}.quarantine.${attemptId}.${dependencies.createQuarantineId()}`;
}
function listQuarantines(path) {
  const directory = dirname(path);
  const prefix = `${basename(path)}.quarantine.`;
  return readdirSync(directory).filter((entry) => entry.startsWith(prefix)).map((entry) => join2(directory, entry));
}
function sameLockOwner(first, second) {
  return first !== null && second !== null && first.attemptId === second.attemptId && first.pid === second.pid;
}
function unlinkIfPresent(path, dependencies) {
  try {
    dependencies.unlinkFile(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}
function restoreWithoutOverwrite(capturedPath, lockPath, dependencies) {
  try {
    dependencies.copyFileExclusive(capturedPath, lockPath);
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
    if (!sameLockOwner(readLockRecord(capturedPath), readLockRecord(lockPath))) return false;
  }
  unlinkIfPresent(capturedPath, dependencies);
  return true;
}
function captureCurrentLock(path, attemptId, dependencies) {
  const capturedPath = quarantinePath(path, attemptId, dependencies);
  try {
    renameSync(path, capturedPath);
    return capturedPath;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}
function recoverCapturedLock(path, attemptId, staleMs, dependencies) {
  const capturedPath = captureCurrentLock(path, attemptId, dependencies);
  if (capturedPath === null) return true;
  if (discardExpiredQuarantine(capturedPath, staleMs, dependencies)) return true;
  restoreWithoutOverwrite(capturedPath, path, dependencies);
  return false;
}
function discardExpiredQuarantine(capturedPath, staleMs, dependencies) {
  const capturedRecord = readLockRecord(capturedPath);
  let isExpired;
  try {
    isExpired = capturedRecord?.leaseExpiresAt !== null && capturedRecord?.leaseExpiresAt !== void 0 ? dependencies.wallNow() >= Date.parse(capturedRecord.leaseExpiresAt) : dependencies.wallNow() - statSync(capturedPath).mtimeMs >= staleMs;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  if (!isExpired) return false;
  unlinkIfPresent(capturedPath, dependencies);
  return true;
}
function quarantineBlocksAcquisition(path, staleMs, dependencies) {
  let isBlocked = false;
  for (const capturedPath of listQuarantines(path)) {
    if (!discardExpiredQuarantine(capturedPath, staleMs, dependencies)) isBlocked = true;
  }
  return isBlocked;
}
function mayBeStale(path, staleMs, dependencies) {
  try {
    return dependencies.wallNow() - statSync(path).mtimeMs >= staleMs;
  } catch {
    return true;
  }
}
function releaseOwnedLock(path, attemptId, dependencies) {
  const capturedPath = captureCurrentLock(path, attemptId, dependencies);
  let didReleaseCanonical = false;
  if (capturedPath !== null) {
    const capturedRecord = readLockRecord(capturedPath);
    if (capturedRecord?.attemptId === attemptId) {
      unlinkIfPresent(capturedPath, dependencies);
      didReleaseCanonical = true;
    } else {
      restoreWithoutOverwrite(capturedPath, path, dependencies);
    }
  }
  let didReleaseFence = false;
  for (const quarantine of listQuarantines(path)) {
    if (readLockRecord(quarantine)?.attemptId !== attemptId) continue;
    unlinkIfPresent(quarantine, dependencies);
    didReleaseFence = true;
  }
  return didReleaseCanonical || didReleaseFence;
}
function releaseOwnedLockAfter(path, attemptId, dependencies, finalizer) {
  const capturedPath = captureCurrentLock(path, attemptId, dependencies);
  if (capturedPath === null) return false;
  if (readLockRecord(capturedPath)?.attemptId !== attemptId) {
    restoreWithoutOverwrite(capturedPath, path, dependencies);
    return false;
  }
  try {
    finalizer();
  } catch (error) {
    try {
      if (!restoreWithoutOverwrite(capturedPath, path, dependencies)) {
        throw new Error("Preview start lock ownership could not be restored");
      }
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Preview finalization failed and start lock ownership could not be restored"
      );
    }
    throw error;
  }
  unlinkIfPresent(capturedPath, dependencies);
  for (const quarantine of listQuarantines(path)) {
    if (readLockRecord(quarantine)?.attemptId !== attemptId) continue;
    unlinkIfPresent(quarantine, dependencies);
  }
  return true;
}
function writeRecordFile(path, record) {
  const descriptor = openSync(path, "wx", 384);
  let isComplete = false;
  try {
    writeFileSync(descriptor, `${JSON.stringify(record)}
`);
    fsyncSync(descriptor);
    isComplete = true;
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      if (!isComplete) rmSync(path, { force: true });
    }
  }
}
function updateOwnedLockPid(path, attemptId, pid, staleMs, dependencies) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const childFenceRecord = {
    attemptId,
    pid,
    createdAt: new Date(dependencies.wallNow()).toISOString(),
    leaseExpiresAt: new Date(dependencies.wallNow() + staleMs).toISOString()
  };
  const childFence = quarantinePath(path, attemptId, dependencies);
  writeRecordFile(childFence, childFenceRecord);
  const parentRecord = readLockRecord(path);
  if (parentRecord?.attemptId !== attemptId) return false;
  const childRecord = { ...parentRecord, pid };
  const ownerTemp = `${path}.owner.tmp.${attemptId}.${dependencies.createQuarantineId()}`;
  let hasOwnerTemp = false;
  try {
    writeRecordFile(ownerTemp, childRecord);
    hasOwnerTemp = true;
    if (readLockRecord(path)?.attemptId !== attemptId) return false;
    dependencies.publishOwnerRecord(ownerTemp, path);
    hasOwnerTemp = false;
    if (!sameLockOwner(readLockRecord(path), childRecord)) return false;
    unlinkIfPresent(childFence, dependencies);
    return true;
  } finally {
    if (hasOwnerTemp) rmSync(ownerTemp, { force: true });
  }
}
async function acquirePreviewStartLock(options, dependencyOverrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const lockStartedAt = dependencies.now();
  while (dependencies.now() < options.deadline) {
    if (quarantineBlocksAcquisition(options.path, options.staleMs, dependencies)) {
      const remainingMs = options.deadline - dependencies.now();
      if (remainingMs <= 0) break;
      await dependencies.sleep(Math.min(options.pollIntervalMs, remainingMs));
      continue;
    }
    try {
      const descriptor = openSync(options.path, "wx", 384);
      try {
        const record = {
          attemptId: options.attemptId,
          pid: process.pid,
          createdAt: new Date(dependencies.wallNow()).toISOString(),
          leaseExpiresAt: new Date(dependencies.wallNow() + options.staleMs).toISOString()
        };
        writeFileSync(descriptor, `${JSON.stringify(record)}
`);
      } finally {
        closeSync(descriptor);
      }
      if (listQuarantines(options.path).length > 0) {
        releaseOwnedLock(options.path, options.attemptId, dependencies);
        const remainingMs = options.deadline - dependencies.now();
        if (remainingMs <= 0) break;
        await dependencies.sleep(Math.min(options.pollIntervalMs, remainingMs));
        continue;
      }
      return {
        lockMs: dependencies.now() - lockStartedAt,
        release: () => releaseOwnedLock(options.path, options.attemptId, dependencies),
        releaseAfter: (finalizer) => releaseOwnedLockAfter(options.path, options.attemptId, dependencies, finalizer),
        updateOwnerPid: (pid) => updateOwnedLockPid(options.path, options.attemptId, pid, options.staleMs, dependencies)
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      if (mayBeStale(options.path, options.staleMs, dependencies) && recoverCapturedLock(options.path, options.attemptId, options.staleMs, dependencies)) {
        continue;
      }
      const remainingMs = options.deadline - dependencies.now();
      if (remainingMs <= 0) break;
      await dependencies.sleep(Math.min(options.pollIntervalMs, remainingMs));
    }
  }
  throw new Error(
    "Preview did not become ready within 10 seconds while waiting for its start lock"
  );
}

// src/preview-process.ts
import { spawn } from "node:child_process";
import { closeSync as closeSync2, openSync as openSync2 } from "node:fs";
import { fileURLToPath } from "node:url";
var DEFAULT_TIMER_DEPENDENCIES = {
  clearTimer: (timer) => clearTimeout(timer),
  now: () => performance.now(),
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds)
};
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isPort(value) {
  return isPositiveInteger(value) && value <= 65535;
}
function parseChildMessage(value) {
  if (!isRecord2(value) || typeof value.type !== "string") return null;
  if (value.type === "ready" && typeof value.instanceId === "string" && isPositiveInteger(value.pid) && isPort(value.port) && typeof value.listenMs === "number" && Number.isFinite(value.listenMs) && value.listenMs >= 0) {
    return {
      type: "ready",
      instanceId: value.instanceId,
      pid: value.pid,
      port: value.port,
      listenMs: value.listenMs
    };
  }
  if (value.type === "committed" && typeof value.instanceId === "string") {
    return { type: "committed", instanceId: value.instanceId };
  }
  if (value.type === "failed" && typeof value.instanceId === "string" && typeof value.phase === "string" && typeof value.message === "string") {
    return {
      type: "failed",
      instanceId: value.instanceId,
      phase: value.phase,
      message: value.message
    };
  }
  return null;
}
function previewChildEntry() {
  return fileURLToPath(new URL("./preview-child.js", import.meta.url));
}
function spawnPreviewChild(launch) {
  const logDescriptor = openSync2(launch.logFile, "a");
  try {
    return spawn(process.execPath, [previewChildEntry()], {
      cwd: launch.root,
      env: {
        ...process.env,
        SYNERGY_PROJECT_ROOT: launch.root,
        SYNERGY_SESSIONS_DIR: launch.sessionsDir,
        SYNERGY_PROJECT_ID: launch.projectId,
        SYNERGY_INSTANCE_ID: launch.instanceId,
        SYNERGY_CONTROL_TOKEN: launch.controlToken,
        SYNERGY_PORT: String(launch.port),
        SYNERGY_STRICT_PORT: String(launch.strictPort)
      },
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor, "ipc"]
    });
  } finally {
    closeSync2(logDescriptor);
  }
}
function waitForReadyPreviewChild(child, launch, timeoutMs, dependencyOverrides = {}) {
  const dependencies = { ...DEFAULT_TIMER_DEPENDENCIES, ...dependencyOverrides };
  return new Promise((resolve2, reject) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (result instanceof Error) reject(result);
      else resolve2(result);
    };
    const onMessage = (value) => {
      const message = parseChildMessage(value);
      if (message === null) {
        finish(new Error("Preview child sent an invalid readiness message"));
        return;
      }
      if (message.instanceId !== launch.instanceId) {
        finish(new Error("Preview child readiness identity did not match the launch attempt"));
        return;
      }
      if (message.type === "committed") {
        finish(new Error("Preview child sent a commit acknowledgement before readiness"));
        return;
      }
      if (message.type === "failed") {
        finish(new Error(`Preview child failed during ${message.phase}: ${message.message}`));
        return;
      }
      if (message.pid !== child.pid) {
        finish(new Error("Preview child readiness identity did not match its process"));
        return;
      }
      finish({ pid: message.pid, port: message.port, listenMs: message.listenMs });
    };
    const onError = (error) => {
      finish(
        new Error(
          `Preview child failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    };
    const onExit = (code, signal) => {
      finish(
        new Error(
          `Preview child exited before readiness (code ${String(code)}, signal ${String(signal)})`
        )
      );
    };
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
    timer = dependencies.setTimer(
      () => finish(new Error("Preview did not become ready within 10 seconds")),
      Math.max(0, timeoutMs)
    );
  });
}
function commitReadyPreviewChild(child, instanceId, timeoutMs, dependencyOverrides = {}) {
  const dependencies = { ...DEFAULT_TIMER_DEPENDENCIES, ...dependencyOverrides };
  return new Promise((resolve2, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error === void 0) resolve2();
      else reject(error);
    };
    const onMessage = (value) => {
      const message = parseChildMessage(value);
      if (message?.type !== "committed" || message.instanceId !== instanceId) {
        finish(new Error("Preview child commit acknowledgement did not match the launch instance"));
        return;
      }
      finish();
    };
    const onError = (error) => {
      finish(
        new Error(
          `Preview child failed before commit: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    };
    const onExit = (code, signal) => {
      finish(
        new Error(
          `Preview child exited before commit (code ${String(code)}, signal ${String(signal)})`
        )
      );
    };
    if (child.send === void 0) {
      finish(new Error("Preview child IPC channel is unavailable before commit"));
      return;
    }
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
    timer = dependencies.setTimer(
      () => finish(new Error("Preview child did not acknowledge runtime commit")),
      Math.max(0, timeoutMs)
    );
    try {
      child.send({ type: "commit", instanceId }, (error) => {
        if (error !== null) finish(new Error(`Preview child commit failed: ${error.message}`));
      });
    } catch (error) {
      finish(
        new Error(
          `Preview child commit failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  });
}
function childHasExited(child) {
  return child.exitCode !== void 0 && child.exitCode !== null ? true : child.signalCode !== void 0 && child.signalCode !== null;
}
function waitForChildExit(child, timeoutMs, dependencies) {
  if (childHasExited(child)) return Promise.resolve(true);
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve2) => {
    let settled = false;
    let timer = null;
    const finish = (didExit) => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      child.removeListener("exit", onExit);
      resolve2(didExit);
    };
    const onExit = () => finish(true);
    child.on("exit", onExit);
    if (childHasExited(child)) {
      finish(true);
      return;
    }
    timer = dependencies.setTimer(() => finish(false), timeoutMs);
  });
}
function signalOwnedChild(child, signal) {
  try {
    child.kill(signal);
  } catch {
  }
}
function disconnectOwnedChild(child) {
  try {
    child.disconnect?.();
  } catch {
  }
  child.unref();
}
async function terminateOwnedPreviewChild(child, options, dependencyOverrides = {}) {
  const dependencies = { ...DEFAULT_TIMER_DEPENDENCIES, ...dependencyOverrides };
  if (childHasExited(child)) {
    disconnectOwnedChild(child);
    return true;
  }
  const termWaitMs = Math.max(
    0,
    Math.min(options.termGraceMs, options.deadline - dependencies.now())
  );
  const termExit = waitForChildExit(child, termWaitMs, dependencies);
  signalOwnedChild(child, "SIGTERM");
  if (await termExit) {
    disconnectOwnedChild(child);
    return true;
  }
  const killWaitMs = Math.max(0, options.deadline - dependencies.now());
  const killExit = waitForChildExit(child, killWaitMs, dependencies);
  signalOwnedChild(child, "SIGKILL");
  const didExit = await killExit;
  disconnectOwnedChild(child);
  return didExit;
}
function detachReadyPreviewChild(child) {
  child.disconnect?.();
  child.unref();
}

// src/preview-runtime.ts
import { createHash, randomBytes, randomUUID as randomUUID2 } from "node:crypto";
import {
  constants as constants2,
  closeSync as closeSync3,
  copyFileSync as copyFileSync2,
  openSync as openSync3,
  readFileSync as readFileSync3,
  readdirSync as readdirSync2,
  renameSync as renameSync2,
  unlinkSync as unlinkSync2,
  writeSync
} from "node:fs";
import { basename as basename2, dirname as dirname2, join as join3 } from "node:path";
var LOOPBACK_HOST = "127.0.0.1";
var MAX_PORT = 65535;
var CONTROL_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
var DEFAULT_FILE_DEPENDENCIES = {
  copyFileExclusive: (source, destination) => copyFileSync2(source, destination, constants2.COPYFILE_EXCL)
};
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isPort2(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PORT;
}
function isPositiveInteger2(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isDuration(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function parseTimings(value) {
  if (!isRecord3(value)) return null;
  const keys = ["lockMs", "launchMs", "listenMs", "healthMs", "totalMs"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    return null;
  }
  const { lockMs, launchMs, listenMs, healthMs, totalMs } = value;
  if (!isDuration(lockMs) || !isDuration(launchMs) || !isDuration(listenMs) || !isDuration(healthMs) || !isDuration(totalMs)) {
    return null;
  }
  return { lockMs, launchMs, listenMs, healthMs, totalMs };
}
function isIsoTimestamp(value) {
  if (!isNonEmptyString(value)) return false;
  const parsedTimestamp = new Date(value);
  return !Number.isNaN(parsedTimestamp.getTime()) && parsedTimestamp.toISOString() === value;
}
function isControlToken(value) {
  return typeof value === "string" && CONTROL_TOKEN_PATTERN.test(value);
}
function hasErrorCode2(error, code) {
  return isRecord3(error) && error.code === code;
}
function quarantinePath2(path) {
  return `${path}.quarantine.${process.pid}.${randomUUID2()}`;
}
function listRuntimeQuarantines(path) {
  const directory = dirname2(path);
  const prefix = `${basename2(path)}.quarantine.`;
  try {
    return readdirSync2(directory).filter((entry) => entry.startsWith(prefix)).map((entry) => join3(directory, entry));
  } catch (error) {
    if (hasErrorCode2(error, "ENOENT")) return [];
    throw error;
  }
}
function restoreCapturedFile(capturedPath, destinationPath, dependencies) {
  try {
    dependencies.copyFileExclusive(capturedPath, destinationPath);
  } catch (error) {
    if (!hasErrorCode2(error, "EEXIST")) throw error;
  }
  unlinkSync2(capturedPath);
}
function parsePreviewRuntime(value) {
  if (!isRecord3(value)) return null;
  const requiredKeys = [
    "schemaVersion",
    "protocolVersion",
    "state",
    "instanceId",
    "projectId",
    "pid",
    "host",
    "port",
    "origin",
    "preferredPort",
    "strictPort",
    "startedAt",
    "controlToken",
    "toolVersion"
  ];
  const allowedKeys = /* @__PURE__ */ new Set([...requiredKeys, "timings"]);
  if (requiredKeys.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return null;
  }
  const {
    schemaVersion,
    protocolVersion,
    state,
    instanceId,
    projectId,
    pid,
    host,
    port,
    origin,
    preferredPort,
    strictPort,
    startedAt,
    controlToken,
    toolVersion,
    timings
  } = value;
  if (schemaVersion !== 1 || protocolVersion !== 1 || state !== "ready" || !isNonEmptyString(instanceId) || !isNonEmptyString(projectId) || !isPositiveInteger2(pid) || host !== LOOPBACK_HOST || !isPort2(port) || !isPort2(preferredPort) || typeof strictPort !== "boolean" || !isIsoTimestamp(startedAt) || !isControlToken(controlToken) || !isNonEmptyString(toolVersion)) {
    return null;
  }
  const derivedOrigin = deriveLoopbackOrigin(port);
  if (origin !== derivedOrigin) return null;
  let parsedTimings;
  if (timings !== void 0) {
    const candidate = parseTimings(timings);
    if (candidate === null) return null;
    parsedTimings = candidate;
  }
  return {
    schemaVersion,
    protocolVersion,
    state,
    instanceId,
    projectId,
    pid,
    host,
    port,
    origin: derivedOrigin,
    preferredPort,
    strictPort,
    startedAt,
    controlToken,
    toolVersion,
    ...parsedTimings === void 0 ? {} : { timings: parsedTimings }
  };
}
function deriveProjectId(canonicalRoot) {
  return `sha256:${createHash("sha256").update(canonicalRoot).digest("hex")}`;
}
function deriveLoopbackOrigin(port) {
  if (!isPort2(port)) throw new RangeError(`Invalid loopback port: ${port}`);
  return `http://${LOOPBACK_HOST}:${port}`;
}
function generateControlToken() {
  return randomBytes(32).toString("hex");
}
function readRuntimeFile(path) {
  try {
    return parsePreviewRuntime(JSON.parse(readFileSync3(path, "utf8")));
  } catch {
    return null;
  }
}
function readPreviewRuntime(path) {
  const canonical = readRuntimeFile(path);
  if (canonical !== null) return canonical;
  for (const capturedPath of listRuntimeQuarantines(path)) {
    const captured = readRuntimeFile(capturedPath);
    if (captured !== null) return captured;
  }
  return readRuntimeFile(path);
}
function writePreviewRuntime(path, state) {
  const validatedState = parsePreviewRuntime(state);
  if (validatedState === null) throw new TypeError("Invalid preview runtime state");
  const tempPath = join3(dirname2(path), `.${basename2(path)}.${process.pid}.${randomUUID2()}.tmp`);
  const fileDescriptor = openSync3(tempPath, "wx", 384);
  let shouldRemoveTempFile = true;
  try {
    writeSync(fileDescriptor, `${JSON.stringify(validatedState)}
`, void 0, "utf8");
    closeSync3(fileDescriptor);
    renameSync2(tempPath, path);
    shouldRemoveTempFile = false;
  } finally {
    if (shouldRemoveTempFile) {
      try {
        closeSync3(fileDescriptor);
      } catch {
      }
      try {
        unlinkSync2(tempPath);
      } catch {
      }
    }
  }
}
function removeOwnedPreviewRuntime(path, instanceId, dependencyOverrides = {}) {
  const dependencies = { ...DEFAULT_FILE_DEPENDENCIES, ...dependencyOverrides };
  const capturedPath = quarantinePath2(path);
  try {
    renameSync2(path, capturedPath);
  } catch (error) {
    if (hasErrorCode2(error, "ENOENT")) return false;
    throw error;
  }
  const runtime = readRuntimeFile(capturedPath);
  if (runtime !== null && runtime.instanceId === instanceId) {
    unlinkSync2(capturedPath);
    return true;
  }
  restoreCapturedFile(capturedPath, path, dependencies);
  return false;
}

// src/preview-transport.ts
var DEFAULT_DEPENDENCIES2 = {
  clearTimer: (timer) => clearTimeout(timer),
  fetch: (input, init) => fetch(input, init),
  now: () => performance.now(),
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds)
};
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPositiveInteger3(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isPort3(value) {
  return isPositiveInteger3(value) && value <= 65535;
}
function parseHealth(value) {
  if (!isRecord4(value)) return null;
  const expectedKeys = ["protocolVersion", "state", "instanceId", "projectId", "pid", "port"];
  if (Object.keys(value).length !== expectedKeys.length || expectedKeys.some((key) => !(key in value)) || value.protocolVersion !== 1 || value.state !== "ready" || typeof value.instanceId !== "string" || value.instanceId.length === 0 || typeof value.projectId !== "string" || value.projectId.length === 0 || !isPositiveInteger3(value.pid) || !isPort3(value.port)) {
    return null;
  }
  return {
    protocolVersion: 1,
    state: "ready",
    instanceId: value.instanceId,
    projectId: value.projectId,
    pid: value.pid,
    port: value.port
  };
}
function errorCode(error) {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord4(current)) return null;
    if (typeof current.code === "string") return current.code;
    current = current.cause;
  }
  return null;
}
function requestWithTimeout(input, init, timeoutMs, dependencies) {
  if (timeoutMs <= 0) return Promise.resolve({ kind: "timeout" });
  return new Promise((resolve2) => {
    const controller = new AbortController();
    let settled = false;
    let timer = null;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      resolve2(outcome);
    };
    timer = dependencies.setTimer(() => {
      controller.abort();
      settle({ kind: "timeout" });
    }, timeoutMs);
    void dependencies.fetch(input, { ...init, signal: controller.signal }).then((response) => settle({ kind: "response", response, controller })).catch((error) => {
      if (errorCode(error) === "ECONNREFUSED") settle({ kind: "absent" });
      else settle({ kind: "transport-error", error });
    });
  });
}
function readJsonWithTimeout(response, controller, timeoutMs, dependencies) {
  if (timeoutMs <= 0) {
    abortAndCancelResponse(response, controller);
    return Promise.resolve({ kind: "timeout" });
  }
  return new Promise((resolve2) => {
    let settled = false;
    let timer = null;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      resolve2(outcome);
    };
    timer = dependencies.setTimer(() => {
      abortAndCancelResponse(response, controller);
      settle({ kind: "timeout" });
    }, timeoutMs);
    void response.json().then((value) => settle({ kind: "json", value })).catch(() => settle({ kind: "malformed" }));
  });
}
function abortAndCancelResponse(response, controller) {
  controller.abort();
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== void 0) void cancellation.catch(() => void 0);
  } catch {
  }
}
async function requestPreviewHealth(origin, timeoutMs, dependencyOverrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES2, ...dependencyOverrides };
  const startedAt = dependencies.now();
  const outcome = await requestWithTimeout(
    `${origin}/api/runtime/health`,
    { method: "GET" },
    timeoutMs,
    dependencies
  );
  if (outcome.kind !== "response") return outcome;
  if (!outcome.response.ok) {
    abortAndCancelResponse(outcome.response, outcome.controller);
    return { kind: "http-error", status: outcome.response.status };
  }
  const body = await readJsonWithTimeout(
    outcome.response,
    outcome.controller,
    timeoutMs - (dependencies.now() - startedAt),
    dependencies
  );
  if (body.kind !== "json") return body;
  const health = parseHealth(body.value);
  return health === null ? { kind: "malformed" } : { kind: "healthy", health };
}
async function requestPreviewShutdown(origin, instanceId, controlToken, timeoutMs, dependencyOverrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES2, ...dependencyOverrides };
  const outcome = await requestWithTimeout(
    `${origin}/api/runtime/shutdown`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${controlToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ instanceId })
    },
    timeoutMs,
    dependencies
  );
  if (outcome.kind === "response") {
    abortAndCancelResponse(outcome.response, outcome.controller);
    return outcome.response.ok ? { kind: "accepted" } : { kind: "http-error", status: outcome.response.status };
  }
  if (outcome.kind === "absent") {
    return { kind: "transport-error", error: new Error("Preview disappeared before shutdown") };
  }
  return outcome;
}

// src/version.ts
var SYNERGY_VERSION = "0.21.0";

// src/preview.ts
var START_TIMEOUT_MS = 1e4;
var START_CLEANUP_RESERVE_MS = 1e3;
var STOP_TIMEOUT_MS = 3e3;
var STOP_CLEANUP_RESERVE_MS = 100;
var STATUS_TIMEOUT_MS = 500;
var POLL_INTERVAL_MS = 25;
var LOCK_STALE_MS = START_TIMEOUT_MS;
var TERMINATION_GRACE_MS = 500;
var MAX_LOG_TAIL_BYTES = 4096;
var DEFAULT_DEPENDENCIES3 = {
  canonicalizeRoot: (root) => realpathSync(resolveProjectPaths(root).root),
  cleanupReserveMs: START_CLEANUP_RESERVE_MS,
  clearTimer: (timer) => clearTimeout(timer),
  copyFileExclusive: (source, destination) => copyFileSync3(source, destination, constants3.COPYFILE_EXCL),
  createAttemptId: randomUUID3,
  createControlToken: generateControlToken,
  createInstanceId: randomUUID3,
  createQuarantineId: randomUUID3,
  fetch: (input, init) => fetch(input, init),
  lockStaleMs: LOCK_STALE_MS,
  now: () => performance.now(),
  pollIntervalMs: POLL_INTERVAL_MS,
  processKill: (pid, signal) => process.kill(pid, signal),
  publishOwnerRecord: (source, destination) => renameSync3(source, destination),
  unlinkFile: unlinkSync3,
  removeRuntime: removeOwnedPreviewRuntime,
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  sleep: (milliseconds) => new Promise((resolve2) => setTimeout(resolve2, milliseconds)),
  spawnChild: spawnPreviewChild,
  startTimeoutMs: START_TIMEOUT_MS,
  statusTimeoutMs: STATUS_TIMEOUT_MS,
  stopCleanupReserveMs: STOP_CLEANUP_RESERVE_MS,
  stopTimeoutMs: STOP_TIMEOUT_MS,
  terminationGraceMs: TERMINATION_GRACE_MS,
  wallNow: Date.now,
  writeOutput: (text) => process.stdout.write(text),
  writeRuntime: writePreviewRuntime
};
function mergeDependencies(overrides) {
  return { ...DEFAULT_DEPENDENCIES3, ...overrides };
}
function isRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasErrorCode3(error, code) {
  return isRecord5(error) && error.code === code;
}
function isPositiveInteger4(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function healthMatchesRuntime(health, runtime) {
  return health.protocolVersion === runtime.protocolVersion && health.state === runtime.state && health.instanceId === runtime.instanceId && health.projectId === runtime.projectId && health.pid === runtime.pid && health.port === runtime.port;
}
function healthMatchesLaunch(health, launch, ready) {
  return health.protocolVersion === 1 && health.state === "ready" && health.instanceId === launch.instanceId && health.projectId === launch.projectId && health.pid === ready.pid && health.port === ready.port;
}
function stoppedStatus(projectId) {
  return {
    running: false,
    pid: null,
    port: null,
    origin: null,
    projectId,
    instanceId: null
  };
}
function runningStatus(runtime) {
  return {
    running: true,
    pid: runtime.pid,
    port: runtime.port,
    origin: deriveLoopbackOrigin(runtime.port),
    projectId: runtime.projectId,
    instanceId: runtime.instanceId,
    ...runtime.timings === void 0 ? {} : { timings: runtime.timings }
  };
}
function projectPaths(root, dependencies) {
  return resolveProjectPaths(dependencies.canonicalizeRoot(root));
}
function migrateLegacyPid(pidFile, dependencies) {
  if (!existsSync2(pidFile)) return;
  let pid = null;
  try {
    const raw = readFileSync4(pidFile, "utf8").trim();
    const parsed = Number(raw);
    if (/^[1-9]\d*$/u.test(raw) && isPositiveInteger4(parsed)) pid = parsed;
  } catch {
    return;
  }
  if (pid !== null) {
    try {
      dependencies.processKill(pid, 0);
      return;
    } catch (error) {
      if (!hasErrorCode3(error, "ESRCH")) return;
    }
  }
  try {
    unlinkSync3(pidFile);
  } catch {
  }
}
function transportDependencies(dependencies) {
  return {
    clearTimer: dependencies.clearTimer,
    fetch: dependencies.fetch,
    now: dependencies.now,
    setTimer: dependencies.setTimer
  };
}
function processTimerDependencies(dependencies) {
  return {
    clearTimer: dependencies.clearTimer,
    now: dependencies.now,
    setTimer: dependencies.setTimer
  };
}
function lockDependencies(dependencies) {
  return {
    copyFileExclusive: dependencies.copyFileExclusive,
    createQuarantineId: dependencies.createQuarantineId,
    now: dependencies.now,
    publishOwnerRecord: dependencies.publishOwnerRecord,
    unlinkFile: dependencies.unlinkFile,
    wallNow: dependencies.wallNow,
    sleep: dependencies.sleep
  };
}
async function readVerifiedStatusAtPaths(paths, timeoutMs, dependencies) {
  const projectId = deriveProjectId(paths.root);
  const runtime = readPreviewRuntime(paths.previewRuntimeFile);
  if (runtime === null) {
    migrateLegacyPid(paths.previewPidFile, dependencies);
    return stoppedStatus(projectId);
  }
  if (runtime.projectId !== projectId) return stoppedStatus(projectId);
  const outcome = await requestPreviewHealth(
    runtime.origin,
    timeoutMs,
    transportDependencies(dependencies)
  );
  if (outcome.kind !== "healthy" || !healthMatchesRuntime(outcome.health, runtime)) {
    return stoppedStatus(projectId);
  }
  return runningStatus(runtime);
}
async function readVerifiedStatus(root, timeoutMs, dependencies) {
  return readVerifiedStatusAtPaths(projectPaths(root, dependencies), timeoutMs, dependencies);
}
async function pollLaunchHealth(launch, ready, deadline, dependencies) {
  const origin = deriveLoopbackOrigin(ready.port);
  while (dependencies.now() < deadline) {
    const outcome = await requestPreviewHealth(
      origin,
      deadline - dependencies.now(),
      transportDependencies(dependencies)
    );
    if (outcome.kind === "healthy") {
      if (!healthMatchesLaunch(outcome.health, launch, ready)) {
        throw new Error("Preview health identity did not match the launched child");
      }
      return;
    }
    if (outcome.kind === "malformed" || outcome.kind === "http-error") {
      throw new Error("Preview health response was not a valid ready response");
    }
    const remainingMs = deadline - dependencies.now();
    if (remainingMs <= 0) break;
    await dependencies.sleep(Math.min(dependencies.pollIntervalMs, remainingMs));
  }
  throw new Error("Preview did not become ready within 10 seconds");
}
function readLogTail(path) {
  if (!existsSync2(path)) return "";
  let descriptor = null;
  try {
    descriptor = openSync4(path, "r");
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, MAX_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString("utf8").trim();
  } catch {
    return "";
  } finally {
    if (descriptor !== null) closeSync4(descriptor);
  }
}
function withLogTail(error, logFile) {
  const message = error instanceof Error ? error.message : String(error);
  const tail = readLogTail(logFile);
  return new Error(tail.length === 0 ? message : `${message}
Preview log tail:
${tail}`);
}
function withCleanupFailures(primary, cleanupFailures) {
  if (cleanupFailures.length === 0) return primary;
  const details = cleanupFailures.map((failure) => failure.message).join("; ");
  return new Error(`${primary.message}
Preview cleanup failed: ${details}`, {
    cause: new AggregateError([primary, ...cleanupFailures])
  });
}
function buildRuntime(launch, ready, dependencies) {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    state: "ready",
    instanceId: launch.instanceId,
    projectId: launch.projectId,
    pid: ready.pid,
    host: "127.0.0.1",
    port: ready.port,
    origin: deriveLoopbackOrigin(ready.port),
    preferredPort: launch.port,
    strictPort: launch.strictPort,
    startedAt: new Date(dependencies.wallNow()).toISOString(),
    controlToken: launch.controlToken,
    toolVersion: SYNERGY_VERSION
  };
}
async function startPreview(options, dependencies) {
  const invokedAt = dependencies.now();
  const totalDeadline = invokedAt + dependencies.startTimeoutMs;
  const cleanupReserveMs = Math.min(
    dependencies.cleanupReserveMs,
    Math.max(1, dependencies.startTimeoutMs / 5)
  );
  const workDeadline = totalDeadline - cleanupReserveMs;
  const paths = projectPaths(options.root, dependencies);
  mkdirSync2(paths.synergyDir, { recursive: true });
  if (dependencies.now() >= workDeadline) {
    throw new Error("Preview did not become ready within 10 seconds");
  }
  const attemptId = dependencies.createAttemptId();
  let lock = null;
  let child = null;
  let instanceId = null;
  let hasPublishedRuntime = false;
  let shouldReleaseLock = true;
  try {
    lock = await acquirePreviewStartLock(
      {
        path: paths.previewLockFile,
        attemptId,
        deadline: workDeadline,
        staleMs: dependencies.lockStaleMs,
        pollIntervalMs: dependencies.pollIntervalMs
      },
      lockDependencies(dependencies)
    );
    const statusTimeoutMs = Math.max(
      0,
      Math.min(dependencies.statusTimeoutMs, workDeadline - dependencies.now())
    );
    const existing = await readVerifiedStatusAtPaths(paths, statusTimeoutMs, dependencies);
    if (existing.running) {
      if (!options.quiet) {
        dependencies.writeOutput(
          `${yellow("!")} Preview already running (pid ${existing.pid}) at ${existing.origin}
`
        );
      }
      return existing;
    }
    if (dependencies.now() >= workDeadline) {
      throw new Error("Preview did not become ready within 10 seconds");
    }
    instanceId = dependencies.createInstanceId();
    const launch = {
      root: paths.root,
      sessionsDir: paths.sessionsDir,
      logFile: paths.previewLogFile,
      projectId: deriveProjectId(paths.root),
      instanceId,
      controlToken: dependencies.createControlToken(),
      port: options.port ?? PREVIEW_PORT,
      strictPort: options.port !== void 0
    };
    const launchStartedAt = dependencies.now();
    child = dependencies.spawnChild(launch);
    if (!isPositiveInteger4(child.pid)) throw new Error("Failed to spawn preview child");
    if (!lock.updateOwnerPid(child.pid)) {
      throw new Error("Preview start lock owner update did not succeed");
    }
    const launchMs = dependencies.now() - launchStartedAt;
    const ready = await waitForReadyPreviewChild(
      child,
      launch,
      workDeadline - dependencies.now(),
      processTimerDependencies(dependencies)
    );
    const healthStartedAt = dependencies.now();
    await pollLaunchHealth(launch, ready, workDeadline, dependencies);
    const healthMs = dependencies.now() - healthStartedAt;
    if (dependencies.now() >= workDeadline) {
      throw new Error("Preview did not become ready within 10 seconds");
    }
    const runtime = buildRuntime(launch, ready, dependencies);
    dependencies.writeRuntime(paths.previewRuntimeFile, runtime);
    hasPublishedRuntime = true;
    if (dependencies.now() > workDeadline) {
      throw new Error("Preview did not become ready within 10 seconds");
    }
    await commitReadyPreviewChild(
      child,
      launch.instanceId,
      workDeadline - dependencies.now(),
      processTimerDependencies(dependencies)
    );
    detachReadyPreviewChild(child);
    const publication = {};
    const acquiredLock = lock;
    if (!acquiredLock.releaseAfter(() => {
      const measuredRuntime = {
        ...runtime,
        timings: {
          lockMs: acquiredLock.lockMs,
          launchMs,
          listenMs: ready.listenMs,
          healthMs,
          totalMs: dependencies.now() - invokedAt
        }
      };
      dependencies.writeRuntime(paths.previewRuntimeFile, measuredRuntime);
      publication.runtime = measuredRuntime;
    })) {
      throw new Error("Preview start lock release did not succeed");
    }
    shouldReleaseLock = false;
    lock = null;
    if (dependencies.now() > totalDeadline) {
      throw new Error("Preview did not become ready within 10 seconds");
    }
    const finalizedRuntime = publication.runtime;
    if (finalizedRuntime === void 0) {
      throw new Error("Preview runtime finalization did not succeed");
    }
    if (!options.quiet) {
      dependencies.writeOutput(
        `${green2("\u2713")} Preview started (pid ${finalizedRuntime.pid}) at ${dim(finalizedRuntime.origin)}
`
      );
      dependencies.writeOutput(`  Log: ${dim(paths.previewLogFile)}
`);
    }
    child = null;
    return runningStatus(finalizedRuntime);
  } catch (error) {
    const failure = withLogTail(error, paths.previewLogFile);
    const cleanupFailures = [];
    if (hasPublishedRuntime && instanceId !== null) {
      try {
        if (!dependencies.removeRuntime(paths.previewRuntimeFile, instanceId)) {
          cleanupFailures.push(new Error("runtime metadata removal did not succeed"));
        }
      } catch (cleanupError) {
        cleanupFailures.push(
          new Error(
            `runtime metadata removal failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
          )
        );
      }
    }
    if (child !== null) {
      const didExit = await terminateOwnedPreviewChild(
        child,
        { deadline: totalDeadline, termGraceMs: dependencies.terminationGraceMs },
        processTimerDependencies(dependencies)
      );
      if (!didExit) {
        shouldReleaseLock = false;
      }
    }
    if (lock !== null && shouldReleaseLock) {
      shouldReleaseLock = false;
      try {
        if (!lock.release()) cleanupFailures.push(new Error("start lock release did not succeed"));
      } catch (releaseError) {
        cleanupFailures.push(
          new Error(
            `start lock release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`
          )
        );
      }
    }
    throw withCleanupFailures(failure, cleanupFailures);
  } finally {
    if (lock !== null && shouldReleaseLock) lock.release();
  }
}
function isDefinitiveDisappearance(outcome, runtime) {
  return outcome.kind === "absent" || outcome.kind === "healthy" && !healthMatchesRuntime(outcome.health, runtime);
}
async function stopPreview(root, options, dependencies) {
  const invokedAt = dependencies.now();
  const totalDeadline = invokedAt + dependencies.stopTimeoutMs;
  const cleanupReserveMs = Math.min(
    dependencies.stopCleanupReserveMs,
    Math.max(1, dependencies.stopTimeoutMs / 5)
  );
  const workDeadline = totalDeadline - cleanupReserveMs;
  const paths = projectPaths(root, dependencies);
  let lock;
  try {
    lock = await acquirePreviewStartLock(
      {
        path: paths.previewLockFile,
        attemptId: dependencies.createAttemptId(),
        deadline: workDeadline,
        staleMs: dependencies.lockStaleMs,
        pollIntervalMs: dependencies.pollIntervalMs
      },
      lockDependencies(dependencies)
    );
  } catch {
    return false;
  }
  try {
    const projectId = deriveProjectId(paths.root);
    const runtime = readPreviewRuntime(paths.previewRuntimeFile);
    if (runtime === null) {
      migrateLegacyPid(paths.previewPidFile, dependencies);
      if (!options.quiet) {
        dependencies.writeOutput(`${yellow("!")} No verified preview server recorded
`);
      }
      return false;
    }
    if (runtime.projectId !== projectId || dependencies.now() >= workDeadline) return false;
    const initial = await requestPreviewHealth(
      runtime.origin,
      Math.max(0, Math.min(dependencies.statusTimeoutMs, workDeadline - dependencies.now())),
      transportDependencies(dependencies)
    );
    if (initial.kind !== "healthy" || !healthMatchesRuntime(initial.health, runtime) || dependencies.now() >= workDeadline) {
      return false;
    }
    const shutdown = await requestPreviewShutdown(
      runtime.origin,
      runtime.instanceId,
      runtime.controlToken,
      workDeadline - dependencies.now(),
      transportDependencies(dependencies)
    );
    if (shutdown.kind !== "accepted" || dependencies.now() >= workDeadline) return false;
    while (dependencies.now() < workDeadline) {
      const outcome = await requestPreviewHealth(
        runtime.origin,
        Math.max(0, Math.min(dependencies.statusTimeoutMs, workDeadline - dependencies.now())),
        transportDependencies(dependencies)
      );
      if (isDefinitiveDisappearance(outcome, runtime)) {
        const removed = dependencies.removeRuntime(paths.previewRuntimeFile, runtime.instanceId);
        if (!removed || dependencies.now() > totalDeadline) return false;
        if (!options.quiet) {
          dependencies.writeOutput(`${green2("\u2713")} Preview stopped (pid ${runtime.pid})
`);
        }
        return true;
      }
      const remainingMs = workDeadline - dependencies.now();
      if (remainingMs <= 0) break;
      await dependencies.sleep(Math.min(dependencies.pollIntervalMs, remainingMs));
    }
    return false;
  } finally {
    lock.release();
  }
}
function createPreviewLifecycle(dependencyOverrides = {}) {
  const dependencies = mergeDependencies(dependencyOverrides);
  return {
    start: (options = {}) => startPreview(options, dependencies),
    status: (root) => readVerifiedStatus(root, dependencies.statusTimeoutMs, dependencies),
    stop: (root, options = {}) => stopPreview(root, options, dependencies)
  };
}
var defaultLifecycle = createPreviewLifecycle();
async function previewStatus(root) {
  return defaultLifecycle.status(root);
}
async function previewStart(options = {}) {
  return defaultLifecycle.start(options);
}
async function previewStop(root, options = {}) {
  return defaultLifecycle.stop(root, options);
}
function printStatus(status) {
  if (status.running) {
    process.stdout.write(`${green2("\u25CF")} running  pid ${status.pid}  ${status.origin}
`);
  } else {
    process.stdout.write(`${dim("\u25CB")} stopped
`);
  }
}

// src/execstate.ts
import { existsSync as existsSync3 } from "node:fs";
import { join as join4 } from "node:path";
import {
  appendFinding,
  deriveProgress,
  readProgress,
  setPhaseStatus,
  setResume,
  writeHandoff
} from "@synergy/state";
import { bold, dim as dim2, green as green3 } from "kleur/colors";
var STATUS_VALUES = [
  "draft",
  "proposed",
  "in-progress",
  "blocked",
  "done",
  "shipped"
];
function resolveSessionDir(root, session) {
  const paths = resolveProjectPaths(root);
  const dir = join4(paths.sessionsDir, session);
  if (!existsSync3(dir)) {
    throw new Error(`session "${session}" not found at ${dir}`);
  }
  return dir;
}
function phaseSet(args) {
  if (!STATUS_VALUES.includes(args.status)) {
    throw new Error(`invalid status "${args.status}" \u2014 use one of: ${STATUS_VALUES.join(", ")}`);
  }
  const sessionDir = resolveSessionDir(args.root, args.session);
  setPhaseStatus(sessionDir, args.phaseId, args.status, { note: args.note });
  process.stdout.write(
    `${green3("\u2713")} ${args.session} ${dim2("\u203A")} phase ${bold(args.phaseId)} \u2192 ${args.status}
`
  );
}
function logFinding(args) {
  if (!args.phase && !args.global) {
    throw new Error("a finding needs a target \u2014 pass --phase or --global");
  }
  const sessionDir = resolveSessionDir(args.root, args.session);
  appendFinding(sessionDir, args.global ? { global: true } : { phase: args.phase }, args.text);
  const where = args.global ? "global" : `phase ${args.phase}`;
  process.stdout.write(`${green3("\u2713")} logged finding to ${dim2(where)}
`);
}
function resumeSet(args) {
  const sessionDir = resolveSessionDir(args.root, args.session);
  setResume(sessionDir, { nextPhase: args.next, note: args.note });
  process.stdout.write(`${green3("\u2713")} resume \u2192 ${bold(args.next ?? "(unset)")}
`);
}
function printProgress(args) {
  const sessionDir = resolveSessionDir(args.root, args.session);
  const progress = readProgress(sessionDir);
  const { done, total, percent } = deriveProgress(progress);
  const lines = [];
  lines.push(`${bold(args.session)}  ${done}/${total} phases done (${percent}%)`);
  if (progress.resume.nextPhase || progress.resume.note) {
    lines.push(
      `  next: ${progress.resume.nextPhase ?? "\u2014"}${progress.resume.note ? ` \u2014 ${progress.resume.note}` : ""}`
    );
  }
  for (const phase of progress.phases) {
    lines.push(`  ${dim2("\u2022")} ${phase.slug}  ${phase.status}`);
  }
  if (progress.phases.length === 0) lines.push(`  ${dim2("(no phases recorded yet)")}`);
  return lines.join("\n");
}

// src/review-actions.ts
import { readFileSync as readFileSync5 } from "node:fs";
import { join as join5 } from "node:path";
import { performance as performance2 } from "node:perf_hooks";
import {
  applyCodeSections,
  buildDiffSnapshot,
  buildScopeSnapshot,
  compareReviewSourceFreshness as compareReviewSourceFreshness2,
  createReviewStore,
  deriveReviewReadiness,
  deriveSnapshotRemovalRuns as deriveSnapshotRemovalRuns2,
  formatReviewRef,
  hashText,
  isReviewCoreError,
  reconcileReview
} from "@synergy/review-core";

// src/review-analysis-guidance.ts
function capturedTextCounts(snapshot) {
  if (snapshot.kind === "scope") {
    const textFiles2 = snapshot.files.filter((file) => !file.binary);
    return {
      textFiles: textFiles2.length,
      textLines: textFiles2.reduce((total, file) => total + file.lines.length, 0)
    };
  }
  const textFiles = snapshot.files.filter((file) => !file.binary);
  return {
    textFiles: textFiles.length,
    textLines: textFiles.reduce(
      (total, file) => total + file.hunks.reduce((fileTotal, hunk) => fileTotal + hunk.lines.length, 0),
      0
    )
  };
}
function boundedSectionCount(textFiles, textLines, linesPerSection) {
  return Math.max(textFiles, Math.min(30, Math.ceil(textLines / linesPerSection)));
}
function deriveReviewAnalysisGuidance(snapshot) {
  const { textFiles, textLines } = capturedTextCounts(snapshot);
  return {
    textFiles,
    textLines,
    minimumSections: boundedSectionCount(textFiles, textLines, 150),
    targetSections: boundedSectionCount(textFiles, textLines, 120),
    maximumSections: boundedSectionCount(textFiles, textLines, 100),
    scopeTooBroad: textFiles > 30 || textLines > 4500
  };
}

// src/review-analysis.ts
var IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
var GROUP_ID = /^[a-z0-9][a-z0-9_-]*$/u;
var MAX_DESCRIPTION_LENGTH = 600;
var FILE_INSIGHT_KEYS = ["path", "description", "confidence"];
var MAX_SUMMARY_LENGTH = 600;
var MAX_INTRO_LENGTH = 300;
function propertyPath(path, key) {
  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}
function fail(path, expectation) {
  throw new Error(`${path} ${expectation}`);
}
function assertRecord(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
}
function assertOnlyKeys(value, keys, path) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(propertyPath(path, key), "is not allowed");
  }
}
function assertArray(value, path) {
  if (!Array.isArray(value)) fail(path, "must be an array");
}
function assertNonEmptyArray(value, path) {
  assertArray(value, path);
  if (value.length === 0) fail(path, "must not be empty");
}
function assertString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "must be a non-empty string");
  }
}
function assertGroupId(value, path) {
  assertString(value, path);
  if (!GROUP_ID.test(value)) {
    fail(path, "must match ^[a-z0-9][a-z0-9_-]*$");
  }
}
function assertDescription(value, path) {
  assertString(value, path);
  if (Array.from(value).length > MAX_DESCRIPTION_LENGTH) {
    fail(path, `must contain at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
}
function assertBoundedText(value, path, max) {
  assertString(value, path);
  if (Array.from(value).length > max) {
    fail(path, `must contain at most ${max} characters`);
  }
}
function assertInteger(value, path) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail(path, "must be a positive integer");
  }
}
function parseConfidence(value, path) {
  if (value === "high" || value === "medium" || value === "low") return value;
  return fail(path, 'must be one of "high", "medium", or "low"');
}
function parseStringArray(value, path) {
  assertNonEmptyArray(value, path);
  const result = value.map((entry, index) => {
    assertString(entry, `${path}[${index}]`);
    return entry;
  });
  assertUniqueValues(result, path);
  return result;
}
function assertUniqueValues(values, path) {
  const indexes = /* @__PURE__ */ new Map();
  for (const [index, value] of values.entries()) {
    const firstIndex = indexes.get(value);
    if (firstIndex !== void 0) {
      fail(`${path}[${index}]`, `duplicates ${path}[${firstIndex}]`);
    }
    indexes.set(value, index);
  }
}
function assertUniqueProperty(values, path, property, select) {
  const indexes = /* @__PURE__ */ new Map();
  for (const [index, value] of values.entries()) {
    const selected = select(value);
    const firstIndex = indexes.get(selected);
    if (firstIndex !== void 0) {
      fail(
        propertyPath(`${path}[${index}]`, property),
        `duplicates ${propertyPath(`${path}[${firstIndex}]`, property)}`
      );
    }
    indexes.set(selected, index);
  }
}
function parseDiffGroup(value, index) {
  const path = `$.groups[${index}]`;
  assertRecord(value, path);
  assertOnlyKeys(value, ["id", "label", "reviewItemIds", "intro"], path);
  assertGroupId(value.id, `${path}.id`);
  assertString(value.label, `${path}.label`);
  if (value.intro !== void 0) assertBoundedText(value.intro, `${path}.intro`, MAX_INTRO_LENGTH);
  return {
    id: value.id,
    label: value.label,
    reviewItemIds: parseStringArray(value.reviewItemIds, `${path}.reviewItemIds`),
    ...value.intro === void 0 ? {} : { intro: value.intro }
  };
}
function parseDiffItem(value, index) {
  const path = `$.items[${index}]`;
  assertRecord(value, path);
  assertOnlyKeys(value, ["reviewItemId", "description", "confidence", "evidencePaths"], path);
  assertString(value.reviewItemId, `${path}.reviewItemId`);
  assertDescription(value.description, `${path}.description`);
  return {
    reviewItemId: value.reviewItemId,
    description: value.description,
    confidence: parseConfidence(value.confidence, `${path}.confidence`),
    evidencePaths: parseStringArray(value.evidencePaths, `${path}.evidencePaths`)
  };
}
function parseScopeGroup(value, index) {
  const path = `$.groups[${index}]`;
  assertRecord(value, path);
  assertOnlyKeys(value, ["id", "label", "sectionKeys", "intro"], path);
  assertGroupId(value.id, `${path}.id`);
  assertString(value.label, `${path}.label`);
  if (value.intro !== void 0) assertBoundedText(value.intro, `${path}.intro`, MAX_INTRO_LENGTH);
  return {
    id: value.id,
    label: value.label,
    sectionKeys: parseStringArray(value.sectionKeys, `${path}.sectionKeys`),
    ...value.intro === void 0 ? {} : { intro: value.intro }
  };
}
function parseScopeSection(value, index) {
  const path = `$.sections[${index}]`;
  assertRecord(value, path);
  assertOnlyKeys(
    value,
    [
      "key",
      "path",
      "label",
      "parentLabel",
      "start",
      "end",
      "description",
      "confidence",
      "evidencePaths"
    ],
    path
  );
  assertString(value.key, `${path}.key`);
  assertString(value.path, `${path}.path`);
  assertString(value.label, `${path}.label`);
  if (value.parentLabel !== void 0) {
    assertString(value.parentLabel, `${path}.parentLabel`);
  }
  assertInteger(value.start, `${path}.start`);
  assertInteger(value.end, `${path}.end`);
  assertDescription(value.description, `${path}.description`);
  return {
    key: value.key,
    path: value.path,
    label: value.label,
    ...value.parentLabel === void 0 ? {} : { parentLabel: value.parentLabel },
    start: value.start,
    end: value.end,
    description: value.description,
    confidence: parseConfidence(value.confidence, `${path}.confidence`),
    evidencePaths: parseStringArray(value.evidencePaths, `${path}.evidencePaths`)
  };
}
function parseFile(value, index) {
  const path = `$.files[${index}]`;
  assertRecord(value, path);
  assertOnlyKeys(value, FILE_INSIGHT_KEYS, path);
  assertString(value.path, `${path}.path`);
  assertDescription(value.description, `${path}.description`);
  return {
    path: value.path,
    description: value.description,
    confidence: parseConfidence(value.confidence, `${path}.confidence`)
  };
}
function parseFiles(value) {
  assertNonEmptyArray(value, "$.files");
  const files = value.map(parseFile);
  assertUniqueProperty(files, "$.files", "path", (file) => file.path);
  return files;
}
function parseGroups(value, parseGroup) {
  assertNonEmptyArray(value, "$.groups");
  const groups = value.map(parseGroup);
  assertUniqueProperty(groups, "$.groups", "id", (group) => group.id);
  return groups;
}
function assertEveryReferenceIsOwned(definitions, definitionPath, references, referencePath) {
  const definitionIndexes = new Map(definitions.map((key, index) => [key, index]));
  const owners = /* @__PURE__ */ new Map();
  for (const [groupIndex, groupReferences] of references.entries()) {
    for (const [referenceIndex, reference] of groupReferences.entries()) {
      const path = referencePath(groupIndex, referenceIndex);
      if (!definitionIndexes.has(reference)) fail(path, "references an unknown item");
      const firstPath = owners.get(reference);
      if (firstPath !== void 0) fail(path, `duplicates ${firstPath}`);
      owners.set(reference, path);
    }
  }
  for (const [index, key] of definitions.entries()) {
    if (!owners.has(key)) fail(definitionPath(index), "is not referenced by any group");
  }
}
var REMOVAL_REASONS = /* @__PURE__ */ new Set([
  "moved",
  "merged",
  "replaced",
  "dead-code",
  "obsolete",
  "extracted-to-dep",
  "unclear"
]);
function parseRemovalRunRef(value, path) {
  assertRecord(value, path);
  assertOnlyKeys(value, ["path", "start", "end"], path);
  assertString(value.path, `${path}.path`);
  assertInteger(value.start, `${path}.start`);
  assertInteger(value.end, `${path}.end`);
  return { path: value.path, start: value.start, end: value.end };
}
function parseRemovalRationale(value, index) {
  const path = `$.removals[${index}]`;
  assertRecord(value, path);
  assertOnlyKeys(value, ["reviewItemId", "run", "reason", "description", "movedTo"], path);
  assertString(value.reviewItemId, `${path}.reviewItemId`);
  assertDescription(value.description, `${path}.description`);
  if (typeof value.reason !== "string" || !REMOVAL_REASONS.has(value.reason)) {
    fail(`${path}.reason`, "must be a known removal reason");
  }
  return {
    reviewItemId: value.reviewItemId,
    run: parseRemovalRunRef(value.run, `${path}.run`),
    reason: value.reason,
    description: value.description,
    ...value.movedTo === void 0 ? {} : { movedTo: parseRemovalRunRef(value.movedTo, `${path}.movedTo`) }
  };
}
function parseRemovals(value) {
  assertNonEmptyArray(value, "$.removals");
  return value.map(parseRemovalRationale);
}
function parseDiffAnalysis(value) {
  assertOnlyKeys(value, ["groups", "items", "removals", "files", "summary"], "$");
  const groups = parseGroups(value.groups, parseDiffGroup);
  assertNonEmptyArray(value.items, "$.items");
  const items = value.items.map(parseDiffItem);
  assertUniqueProperty(items, "$.items", "reviewItemId", (item) => item.reviewItemId);
  assertEveryReferenceIsOwned(
    items.map((item) => item.reviewItemId),
    (index) => `$.items[${index}].reviewItemId`,
    groups.map((group) => group.reviewItemIds),
    (groupIndex, referenceIndex) => `$.groups[${groupIndex}].reviewItemIds[${referenceIndex}]`
  );
  const removals = value.removals === void 0 ? void 0 : parseRemovals(value.removals);
  const files = value.files === void 0 ? void 0 : parseFiles(value.files);
  if (value.summary !== void 0)
    assertBoundedText(value.summary, "$.summary", MAX_SUMMARY_LENGTH);
  return {
    kind: "diff",
    groups,
    items,
    ...removals ? { removals } : {},
    ...files ? { files } : {},
    ...value.summary === void 0 ? {} : { summary: value.summary }
  };
}
function parseScopeAnalysis(value) {
  assertOnlyKeys(value, ["groups", "sections", "files", "summary"], "$");
  const groups = parseGroups(value.groups, parseScopeGroup);
  assertNonEmptyArray(value.sections, "$.sections");
  const sections = value.sections.map(parseScopeSection);
  assertUniqueProperty(sections, "$.sections", "key", (section) => section.key);
  assertEveryReferenceIsOwned(
    sections.map((section) => section.key),
    (index) => `$.sections[${index}].key`,
    groups.map((group) => group.sectionKeys),
    (groupIndex, referenceIndex) => `$.groups[${groupIndex}].sectionKeys[${referenceIndex}]`
  );
  const files = value.files === void 0 ? void 0 : parseFiles(value.files);
  if (value.summary !== void 0)
    assertBoundedText(value.summary, "$.summary", MAX_SUMMARY_LENGTH);
  return {
    kind: "scope",
    groups,
    sections,
    ...files ? { files } : {},
    ...value.summary === void 0 ? {} : { summary: value.summary }
  };
}
function parseReviewAnalysisInput(value) {
  assertRecord(value, "$");
  assertOnlyKeys(value, ["groups", "items", "sections", "removals", "files", "summary"], "$");
  const hasItems = Object.hasOwn(value, "items");
  const hasSections = Object.hasOwn(value, "sections");
  if (hasItems && hasSections) {
    fail("$.items", "is not allowed when $.sections is present");
  }
  if (!hasItems && !hasSections) {
    fail("$", "must contain exactly one of $.items or $.sections");
  }
  return hasItems ? parseDiffAnalysis(value) : parseScopeAnalysis(value);
}

// src/review-capture.ts
import {
  capturePr,
  captureReviewSource,
  captureScope,
  captureStaged,
  captureUnstaged,
  compareReviewSourceFreshness,
  recaptureReviewSource,
  repositoryName,
  resolveRepositoryRoot,
  systemCommandRunner
} from "@synergy/review-core";

// src/review-coverage.ts
function formatRange(section) {
  return `${section.path}:${section.start}-${section.end} (key ${JSON.stringify(section.key)})`;
}
function assertCompleteScopeCoverage(snapshot, sections) {
  const filesByPath = new Map(
    snapshot.files.map((file) => [
      file.path,
      { file, capturedLineNumbers: new Set(file.lines.map((line) => line.number)) }
    ])
  );
  const sectionsByPath = /* @__PURE__ */ new Map();
  const sectionsByKey = /* @__PURE__ */ new Map();
  for (const section of sections) {
    const duplicate = sectionsByKey.get(section.key);
    if (duplicate) {
      throw new Error(
        `duplicate scope section key ${JSON.stringify(section.key)} at ${formatRange(section)}; first declared at ${duplicate.path}:${duplicate.start}-${duplicate.end}`
      );
    }
    sectionsByKey.set(section.key, section);
    const capturedFile = filesByPath.get(section.path);
    if (!capturedFile) {
      throw new Error(`scope range ${formatRange(section)} targets a path that was not captured`);
    }
    const { file, capturedLineNumbers } = capturedFile;
    if (file.binary) {
      throw new Error(`scope range ${formatRange(section)} targets a binary file`);
    }
    if (!Number.isInteger(section.start) || !Number.isInteger(section.end)) {
      throw new Error(`scope range ${formatRange(section)} must use integer captured line numbers`);
    }
    if (section.start > section.end) {
      throw new Error(`scope range ${formatRange(section)} is a reversed range`);
    }
    const missingEndpoint = !capturedLineNumbers.has(section.start) ? section.start : !capturedLineNumbers.has(section.end) ? section.end : void 0;
    if (missingEndpoint !== void 0) {
      throw new Error(
        `scope range ${formatRange(section)} includes ${section.path}:${missingEndpoint}, which is not a captured line`
      );
    }
    const fileSections = sectionsByPath.get(section.path) ?? [];
    fileSections.push(section);
    sectionsByPath.set(section.path, fileSections);
  }
  for (const file of snapshot.files) {
    if (file.binary || file.lines.length === 0) continue;
    const fileSections = sectionsByPath.get(file.path) ?? [];
    const firstLine = file.lines[0].number;
    const lastLine = file.lines[file.lines.length - 1].number;
    if (fileSections.length === 0) {
      throw new Error(
        `incomplete scope coverage for ${file.path}: no sections cover captured lines ${firstLine}-${lastLine}`
      );
    }
    const sorted = [...fileSections].sort(
      (left, right) => left.start - right.start || left.end - right.end
    );
    let expectedLine = firstLine;
    for (const section of sorted) {
      if (section.start !== expectedLine) {
        const problem = section.start < expectedLine ? "overlap" : "gap";
        throw new Error(
          `incomplete scope coverage for ${file.path}: expected line ${expectedLine}; first offending range ${section.start}-${section.end} (key ${JSON.stringify(section.key)}) creates an ${problem}`
        );
      }
      expectedLine = section.end + 1;
    }
    if (expectedLine !== lastLine + 1) {
      const finalSection = sorted[sorted.length - 1];
      throw new Error(
        `incomplete scope coverage for ${file.path}: expected coverage through line ${lastLine}; final offending range ${finalSection.start}-${finalSection.end} (key ${JSON.stringify(finalSection.key)}) leaves a trailing gap`
      );
    }
  }
}

// src/review-removals.ts
import {
  RELOCATING_REMOVAL_REASONS,
  deriveSnapshotRemovalRuns,
  resolveRemovalTarget
} from "@synergy/review-core";
var MAX_MOVED_TO_LINES = 40;
function runKey(path, start, end) {
  return `${path}:${start}-${end}`;
}
function assertSafeEvidencePath(path) {
  if (path.length === 0 || path.includes("\0") || path.startsWith("/") || path.startsWith("\\") || path.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")) {
    throw new Error(`invalid evidence path: ${path}`);
  }
}
function assertCompleteRemovalCoverage(snapshot, removals) {
  const derived = deriveSnapshotRemovalRuns(snapshot);
  if (derived.length === 0 && removals.length === 0) return;
  const derivedByKey = new Map(derived.map((run) => [runKey(run.path, run.start, run.end), run]));
  const seen = /* @__PURE__ */ new Set();
  for (const rationale of removals) {
    const key = runKey(rationale.run.path, rationale.run.start, rationale.run.end);
    const run = derivedByKey.get(key);
    if (!run) {
      throw new Error(`removal rationale ${key} does not match a captured removal run`);
    }
    if (run.reviewItemId !== rationale.reviewItemId) {
      throw new Error(
        `removal rationale ${key} names review item ${rationale.reviewItemId} but the run belongs to ${run.reviewItemId}`
      );
    }
    if (seen.has(key)) throw new Error(`duplicate removal rationale for ${key}`);
    seen.add(key);
    const relocating = RELOCATING_REMOVAL_REASONS.includes(rationale.reason);
    if (relocating && !rationale.movedTo) {
      throw new Error(`removal rationale ${key} with reason ${rationale.reason} requires movedTo`);
    }
    if (!relocating && rationale.movedTo) {
      throw new Error(
        `removal rationale ${key} with reason ${rationale.reason} must not carry movedTo`
      );
    }
    const target = rationale.movedTo;
    if (target) {
      assertSafeEvidencePath(target.path);
      if (target.start > target.end) {
        throw new Error(`removal rationale ${key} has a reversed range in movedTo`);
      }
      if (target.end - target.start + 1 > MAX_MOVED_TO_LINES) {
        throw new Error(
          `removal rationale ${key} movedTo must span at most ${MAX_MOVED_TO_LINES} lines`
        );
      }
    }
  }
  const missing = derived.filter((run) => !seen.has(runKey(run.path, run.start, run.end))).map((run) => runKey(run.path, run.start, run.end));
  if (missing.length > 0) {
    throw new Error(`removal runs are missing a rationale: ${missing.join(", ")}`);
  }
}
function resolveRemovalExcerpts(snapshot, removals, io) {
  return removals.map((rationale) => {
    const target = rationale.movedTo;
    if (!target) return rationale;
    if (resolveRemovalTarget(snapshot, rationale).kind === "in-review") return rationale;
    const lines = io.readTargetLines(target.path);
    if (!lines) {
      throw new Error(`removal rationale movedTo target was not found: ${target.path}`);
    }
    if (target.end > lines.length) {
      throw new Error(
        `removal rationale movedTo ${target.path}:${target.start}-${target.end} is out of range (file has ${lines.length} lines)`
      );
    }
    return {
      ...rationale,
      movedToExcerpt: {
        path: target.path,
        start: target.start,
        lines: lines.slice(target.start - 1, target.end)
      }
    };
  });
}
function reResolveCarriedRemovals(snapshot, removals, io) {
  const resolved = [];
  for (const rationale of removals) {
    const target = rationale.movedTo;
    if (!target) {
      resolved.push(rationale);
      continue;
    }
    if (resolveRemovalTarget(snapshot, rationale).kind === "in-review") {
      resolved.push({
        reviewItemId: rationale.reviewItemId,
        run: rationale.run,
        reason: rationale.reason,
        description: rationale.description,
        movedTo: target
      });
      continue;
    }
    let lines;
    try {
      assertSafeEvidencePath(target.path);
      lines = io.readTargetLines(target.path);
    } catch {
      lines = void 0;
    }
    if (!lines || target.end > lines.length) continue;
    resolved.push({
      reviewItemId: rationale.reviewItemId,
      run: rationale.run,
      reason: rationale.reason,
      description: rationale.description,
      movedTo: target,
      movedToExcerpt: {
        path: target.path,
        start: target.start,
        lines: lines.slice(target.start - 1, target.end)
      }
    });
  }
  return resolved;
}

// src/review-actions.ts
var PreviewNotReadyError = class extends Error {
  constructor(root) {
    const args = ["preview", "start", "--root", root];
    super(
      `Preview is not ready for project root ${JSON.stringify(root)}. Invoke the Synergy executable with argv ${JSON.stringify(args)}.`
    );
    this.root = root;
    this.suggestedCommand = {
      command: "synergy",
      args
    };
  }
  code = "preview_not_ready";
  suggestedCommand;
};
var GROUP_ID2 = /^[a-z0-9][a-z0-9_-]*$/u;
var MAX_DESCRIPTION_LENGTH2 = 600;
function reviewUrl(reference) {
  return `/r/${encodeURIComponent(reference.workspaceId)}/${encodeURIComponent(reference.revisionId)}`;
}
function workspaceIdFor(root, captured) {
  const repository = repositoryName(root);
  switch (captured.source.kind) {
    case "pr":
      return `${repository}-pr-${captured.source.number}`;
    case "staged":
      return `${repository}-staged`;
    case "unstaged":
      return `${repository}-unstaged`;
    case "scope":
      return `${repository}-scope-${hashText(captured.source.patterns.join("\0")).slice(0, 10)}`;
  }
}
function revisionIdFor(captured) {
  return `rev-${captured.fingerprint.slice(0, 16)}`;
}
function initialProgress(snapshot, now) {
  return {
    schemaVersion: 1,
    updatedAt: now,
    items: Object.fromEntries(snapshot.items.map((item) => [item.id, { status: "needs-review" }]))
  };
}
function reconcileProgressAndInsights(previous, snapshot, now) {
  const { insights, ...progress } = reconcileReview(previous, snapshot, now);
  return { progress, files: insights.files, removals: insights.removals };
}
function removalsStatusFor(bundle) {
  const coveredRunKeys = new Set(
    (bundle.insights.removals ?? []).map(
      (rationale) => removalRunKey(rationale.run.path, rationale.run.start, rationale.run.end)
    )
  );
  return deriveSnapshotRemovalRuns2(bundle.snapshot).map((run) => ({
    reviewItemId: run.reviewItemId,
    path: run.path,
    start: run.start,
    end: run.end,
    covered: coveredRunKeys.has(removalRunKey(run.path, run.start, run.end))
  }));
}
function mergeFileInsights(carried, fresh) {
  if (!fresh || fresh.length === 0) return carried;
  if (!carried || carried.length === 0) return fresh;
  const freshPaths = new Set(fresh.map((file) => file.path));
  const survivingCarried = carried.filter((file) => !freshPaths.has(file.path));
  return [...fresh, ...survivingCarried];
}
function removalRunKey(path, start, end) {
  return `${path}:${start}-${end}`;
}
function mergeRemovalInsights(carried, fresh) {
  if (!fresh || fresh.length === 0) return carried;
  if (!carried || carried.length === 0) return fresh;
  const freshKeys = new Set(
    fresh.map(
      (rationale) => removalRunKey(rationale.run.path, rationale.run.start, rationale.run.end)
    )
  );
  const survivingCarried = carried.filter(
    (rationale) => !freshKeys.has(removalRunKey(rationale.run.path, rationale.run.start, rationale.run.end))
  );
  return [...fresh, ...survivingCarried];
}
function buildSnapshot(captured, revisionId, now, predecessorRevisionId) {
  if (captured.source.kind === "scope") {
    if (!captured.files) throw new Error("scope capture did not include eligible source files");
    return buildScopeSnapshot({
      revisionId,
      predecessorRevisionId,
      source: captured.source,
      fingerprint: captured.fingerprint,
      createdAt: now,
      files: captured.files
    });
  }
  if (!captured.patch) throw new Error("diff capture did not include a patch");
  return buildDiffSnapshot({
    revisionId,
    predecessorRevisionId,
    source: captured.source,
    fingerprint: captured.fingerprint,
    createdAt: now,
    patch: captured.patch
  });
}
function resultFor(root, reference, resumed, captured) {
  const store = createReviewStore(root);
  const bundle = store.readBundle(reference.workspaceId, reference.revisionId);
  const excludes = bundle.snapshot.source.excludes;
  return {
    reference,
    resumed,
    url: reviewUrl(reference),
    analysisRequired: !store.isAnalysisFinalized(reference.workspaceId, reference.revisionId),
    removals: removalsStatusFor(bundle),
    ...excludes && excludes.length > 0 ? { excludes } : {},
    ...captured?.excludedFileCount !== void 0 ? { excludedFileCount: captured.excludedFileCount } : {},
    ...bundle.snapshot.kind === "scope" ? { analysisGuidance: deriveReviewAnalysisGuidance(bundle.snapshot) } : {}
  };
}
function createWorkspace(root, workspaceId, revisionId, captured, existing, now) {
  return {
    schemaVersion: 1,
    id: workspaceId,
    repository: { root, name: repositoryName(root) },
    source: captured.source,
    currentRevisionId: revisionId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}
function createOrResumeReview(request, dependencies = {}) {
  const root = resolveRepositoryRoot(request.root, request.runner);
  const captured = captureReviewSource({ ...request, root });
  const store = (dependencies.createStore ?? createReviewStore)(root);
  const workspaceId = workspaceIdFor(root, captured);
  const existingRevision = store.findRevisionByFingerprint(workspaceId, captured.fingerprint);
  if (existingRevision) {
    store.setCurrentRevision(workspaceId, existingRevision, captured.source, {
      root,
      name: repositoryName(root)
    });
    return resultFor(root, { workspaceId, revisionId: existingRevision }, true, captured);
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const revisionId = revisionIdFor(captured);
  const existingWorkspace = store.listWorkspaces().find((workspace2) => workspace2.id === workspaceId);
  const snapshot = buildSnapshot(captured, revisionId, now, existingWorkspace?.currentRevisionId);
  const workspace = createWorkspace(
    root,
    workspaceId,
    revisionId,
    captured,
    existingWorkspace,
    now
  );
  const reconciliation = existingWorkspace ? reconcileProgressAndInsights(
    store.readBundle(workspaceId, existingWorkspace.currentRevisionId),
    snapshot,
    now
  ) : void 0;
  const progress = reconciliation?.progress ?? initialProgress(snapshot, now);
  const carriedRemovals = reconciliation?.removals && reconciliation.removals.length > 0 ? reResolveCarriedRemovals(
    snapshot,
    reconciliation.removals,
    removalExcerptIo(
      root,
      captured.source,
      request.runner ?? systemCommandRunner,
      dependencies.readFile ?? defaultReadFile
    )
  ) : void 0;
  const insights = {
    schemaVersion: 1,
    revisionId,
    groups: [],
    items: [],
    ...reconciliation?.files ? { files: reconciliation.files } : {},
    ...carriedRemovals && carriedRemovals.length > 0 ? { removals: carriedRemovals } : {}
  };
  try {
    store.createRevision(workspace, snapshot, insights, progress);
  } catch (error) {
    if (!isReviewCoreError(error) || error.code !== "review_conflict") throw error;
    const concurrentRevision = store.findRevisionByFingerprint(workspaceId, captured.fingerprint);
    if (!concurrentRevision) throw error;
    store.setCurrentRevision(workspaceId, concurrentRevision, captured.source, {
      root,
      name: repositoryName(root)
    });
    return resultFor(root, { workspaceId, revisionId: concurrentRevision }, true, captured);
  }
  return resultFor(root, { workspaceId, revisionId }, false, captured);
}
function captureRequestFromWorkspace(workspace) {
  const excludes = workspace.source.excludes;
  switch (workspace.source.kind) {
    case "pr":
      return { kind: "pr", selector: workspace.source.url, ...excludes ? { excludes } : {} };
    case "staged":
      return { kind: "staged", ...excludes ? { excludes } : {} };
    case "unstaged":
      return { kind: "unstaged", ...excludes ? { excludes } : {} };
    case "scope":
      return {
        kind: "scope",
        patterns: workspace.source.patterns,
        ...excludes ? { excludes } : {}
      };
  }
}
function refreshReview(request) {
  const root = resolveRepositoryRoot(request.root, request.runner);
  const workspace = createReviewStore(root).readWorkspace(request.workspaceId);
  return createOrResumeReview({
    root,
    runner: request.runner,
    readFile: request.readFile,
    source: captureRequestFromWorkspace(workspace)
  });
}
function assertNarrativeText(value, max, label) {
  if (value.trim().length === 0 || Array.from(value).length > max) {
    throw new Error(`${label} must be 1-${max} characters`);
  }
}
function assertValidAnalysis(snapshot, analysis) {
  if (analysis.summary !== void 0) {
    assertNarrativeText(analysis.summary, MAX_SUMMARY_LENGTH, "review summary");
  }
  for (const group of analysis.groups) {
    if (group.intro !== void 0) {
      assertNarrativeText(group.intro, MAX_INTRO_LENGTH, `group intro: ${group.id}`);
    }
  }
  const itemIds = new Set(snapshot.items.map((item) => item.id));
  const groupIds = /* @__PURE__ */ new Set();
  const groupedItemIds = /* @__PURE__ */ new Set();
  for (const group of analysis.groups) {
    if (!GROUP_ID2.test(group.id)) throw new Error(`invalid review group id: ${group.id}`);
    if (groupIds.has(group.id)) throw new Error(`duplicate review group id: ${group.id}`);
    if (group.label.trim().length === 0) throw new Error("review group label cannot be empty");
    if (group.reviewItemIds.length === 0)
      throw new Error(`review group ${group.id} has no review items`);
    groupIds.add(group.id);
    for (const reviewItemId of group.reviewItemIds) {
      if (!itemIds.has(reviewItemId)) throw new Error(`unknown review item: ${reviewItemId}`);
      if (groupedItemIds.has(reviewItemId)) {
        throw new Error(`review item appears in multiple groups: ${reviewItemId}`);
      }
      groupedItemIds.add(reviewItemId);
    }
  }
  const insightIds = /* @__PURE__ */ new Set();
  const confidenceValues = /* @__PURE__ */ new Set(["high", "medium", "low"]);
  const evidencePaths = new Set(
    snapshot.kind === "diff" ? snapshot.files.map((file) => file.path) : snapshot.files.map((file) => file.path)
  );
  for (const insight of analysis.items) {
    if (!itemIds.has(insight.reviewItemId)) {
      throw new Error(`unknown review item: ${insight.reviewItemId}`);
    }
    if (insightIds.has(insight.reviewItemId)) {
      throw new Error(`duplicate review item analysis: ${insight.reviewItemId}`);
    }
    if (insight.description.trim().length === 0 || Array.from(insight.description).length > MAX_DESCRIPTION_LENGTH2) {
      throw new Error(`review item description must be 1-${MAX_DESCRIPTION_LENGTH2} characters`);
    }
    if (!confidenceValues.has(insight.confidence)) {
      throw new Error(`invalid review item confidence: ${insight.confidence}`);
    }
    for (const path of insight.evidencePaths) assertSafeEvidencePath(path);
    if (insight.evidencePaths.length === 0) {
      throw new Error(`review item analysis requires captured evidence: ${insight.reviewItemId}`);
    }
    if (new Set(insight.evidencePaths).size !== insight.evidencePaths.length) {
      throw new Error(`review item analysis has duplicate evidence paths: ${insight.reviewItemId}`);
    }
    for (const path of insight.evidencePaths) {
      if (!evidencePaths.has(path)) throw new Error(`evidence path was not captured: ${path}`);
    }
    insightIds.add(insight.reviewItemId);
  }
  for (const itemId of itemIds) {
    if (!groupedItemIds.has(itemId)) throw new Error(`review item is missing a group: ${itemId}`);
    if (!insightIds.has(itemId)) throw new Error(`review item is missing an analysis: ${itemId}`);
  }
  assertCompleteRemovalCoverage(snapshot, analysis.removals ?? []);
}
function proposedCodeSection(section) {
  return {
    path: section.path,
    label: section.label,
    ...section.parentLabel === void 0 ? {} : { parentLabel: section.parentLabel },
    start: section.start,
    end: section.end
  };
}
function translateScopeAnalysis(snapshot, analysis, applySections) {
  assertCompleteScopeCoverage(snapshot, analysis.sections);
  const translatedSnapshot = applySections(snapshot, analysis.sections.map(proposedCodeSection));
  if (translatedSnapshot.items.length !== analysis.sections.length) {
    throw new Error("scope section translation did not return one review item per section");
  }
  const itemIdBySectionKey = new Map(
    analysis.sections.map((section, index) => [section.key, translatedSnapshot.items[index].id])
  );
  const groups = analysis.groups.map(
    (group) => ({
      id: group.id,
      label: group.label,
      ...group.intro === void 0 ? {} : { intro: group.intro },
      reviewItemIds: group.sectionKeys.map((sectionKey) => {
        const reviewItemId = itemIdBySectionKey.get(sectionKey);
        if (!reviewItemId) throw new Error(`unknown scope section key: ${sectionKey}`);
        return reviewItemId;
      })
    })
  );
  const items = analysis.sections.map(
    (section, index) => ({
      reviewItemId: translatedSnapshot.items[index].id,
      description: section.description,
      confidence: section.confidence,
      evidencePaths: section.evidencePaths
    })
  );
  return {
    snapshot: translatedSnapshot,
    analysis: {
      groups,
      items,
      ...analysis.summary === void 0 ? {} : { summary: analysis.summary }
    }
  };
}
function splitLines(text) {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function defaultReadFile(path) {
  try {
    return readFileSync5(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
function runOptional(runner, root, args) {
  const result = runner.run("git", args, { cwd: root });
  if (result.exitCode !== 0) return void 0;
  return typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
}
function removalExcerptIo(root, source, runner, readFile) {
  return {
    readTargetLines(path) {
      const spec = source.kind === "pr" ? `${source.headSha}:${path}` : source.kind === "staged" ? `:${path}` : void 0;
      const text = spec === void 0 ? readFile(join5(root, path)) : runOptional(runner, root, ["show", spec]);
      return text === void 0 ? void 0 : splitLines(text);
    }
  };
}
async function applyReviewAnalysis(request, dependencies = {}) {
  const monotonicNow = dependencies.monotonicNow ?? (() => performance2.now());
  const actionStartedAt = readMonotonic(monotonicNow);
  const parsingMs = assertNonnegativeDuration(request.parsingInMs ?? 0, "analysis parsing");
  const store = (dependencies.createStore ?? createReviewStore)(request.root);
  const bundle = store.readBundle(request.reference.workspaceId, request.reference.revisionId);
  if (store.isAnalysisFinalized(request.reference.workspaceId, request.reference.revisionId)) {
    throw new Error("review analysis already exists and is immutable");
  }
  const now = dependencies.now ?? (() => /* @__PURE__ */ new Date());
  let reviewItemCount;
  let groupCount;
  let withinRecommendedRange;
  let finalizedAt;
  let derivationMs = 0;
  let validationMs = 0;
  let publicationMs = 0;
  if (bundle.snapshot.kind === "scope") {
    if (request.analysis.kind !== "scope") {
      throw new Error("scoped review requires a scope analysis payload");
    }
    const scopeSnapshot = bundle.snapshot;
    const scopeAnalysis = request.analysis;
    const translation = measureMonotonic(
      monotonicNow,
      () => translateScopeAnalysis(
        scopeSnapshot,
        scopeAnalysis,
        dependencies.applyCodeSections ?? applyCodeSections
      )
    );
    const translated = translation.value;
    derivationMs += translation.durationMs;
    validationMs += measureMonotonic(monotonicNow, () => {
      assertValidAnalysis(translated.snapshot, translated.analysis);
    }).durationMs;
    const derived = measureMonotonic(monotonicNow, () => {
      const progressTimestamp = nondecreasingIsoTimestamp(bundle.snapshot.createdAt, now());
      const guidance = deriveReviewAnalysisGuidance(bundle.snapshot);
      if (!bundle.snapshot.predecessorRevisionId) {
        return {
          progress: initialProgress(translated.snapshot, progressTimestamp),
          carriedFiles: void 0,
          guidance,
          progressTimestamp
        };
      }
      const reconciled = reconcileProgressAndInsights(
        store.readBundle(request.reference.workspaceId, bundle.snapshot.predecessorRevisionId),
        translated.snapshot,
        progressTimestamp
      );
      return {
        progress: reconciled.progress,
        carriedFiles: reconciled.files,
        guidance,
        progressTimestamp
      };
    });
    derivationMs += derived.durationMs;
    const scopeFiles = mergeFileInsights(derived.value.carriedFiles, scopeAnalysis.files);
    const insights = {
      schemaVersion: 1,
      revisionId: request.reference.revisionId,
      ...translated.analysis.summary === void 0 ? {} : { summary: translated.analysis.summary },
      groups: translated.analysis.groups,
      items: translated.analysis.items,
      ...scopeFiles ? { files: scopeFiles } : {}
    };
    finalizedAt = nondecreasingIsoTimestamp(derived.value.progressTimestamp, now());
    publicationMs += measureMonotonic(monotonicNow, () => {
      store.finalizeScopeAnalysis(
        request.reference.workspaceId,
        request.reference.revisionId,
        translated.snapshot,
        insights,
        derived.value.progress,
        finalizedAt
      );
    }).durationMs;
    reviewItemCount = translated.snapshot.items.length;
    groupCount = translated.analysis.groups.length;
    withinRecommendedRange = reviewItemCount >= derived.value.guidance.minimumSections && reviewItemCount <= derived.value.guidance.maximumSections;
  } else {
    if (request.analysis.kind !== "diff") {
      throw new Error("diff review requires a diff analysis payload");
    }
    const diffAnalysis = request.analysis;
    const carriedRemovals = bundle.insights.removals;
    let resolvedRemovals;
    validationMs += measureMonotonic(monotonicNow, () => {
      assertValidAnalysis(bundle.snapshot, {
        ...diffAnalysis,
        removals: mergeRemovalInsights(carriedRemovals, diffAnalysis.removals) ?? []
      });
      const freshRemovals = diffAnalysis.removals ? resolveRemovalExcerpts(
        bundle.snapshot,
        diffAnalysis.removals,
        removalExcerptIo(
          request.root,
          bundle.snapshot.source,
          request.runner ?? systemCommandRunner,
          request.readFile ?? defaultReadFile
        )
      ) : void 0;
      resolvedRemovals = mergeRemovalInsights(carriedRemovals, freshRemovals);
    }).durationMs;
    const diffFiles = mergeFileInsights(bundle.insights.files, diffAnalysis.files);
    const insights = {
      schemaVersion: 1,
      revisionId: request.reference.revisionId,
      ...diffAnalysis.summary === void 0 ? {} : { summary: diffAnalysis.summary },
      groups: diffAnalysis.groups,
      items: diffAnalysis.items,
      ...resolvedRemovals ? { removals: resolvedRemovals } : {},
      ...diffFiles ? { files: diffFiles } : {}
    };
    finalizedAt = nondecreasingIsoTimestamp(bundle.snapshot.createdAt, now());
    publicationMs += measureMonotonic(monotonicNow, () => {
      store.writeInitialInsights(
        request.reference.workspaceId,
        request.reference.revisionId,
        insights,
        finalizedAt
      );
    }).durationMs;
    reviewItemCount = bundle.snapshot.items.length;
    groupCount = diffAnalysis.groups.length;
    withinRecommendedRange = true;
  }
  const persistedFinalizedAt = store.getAnalysisFinalizedAt(
    request.reference.workspaceId,
    request.reference.revisionId
  );
  if (persistedFinalizedAt !== finalizedAt) {
    throw new Error("review analysis finalization milestone was not persisted");
  }
  const analysisFinalizedInMs = assertFinalizationInterval(
    bundle.snapshot.createdAt,
    persistedFinalizedAt
  );
  const route = reviewUrl(request.reference);
  const baseResult = {
    reference: formatReviewRef(request.reference.workspaceId, request.reference.revisionId),
    analysisFinalized: true,
    reviewItemCount,
    groupCount,
    withinRecommendedRange,
    analysisFinalizedInMs,
    route
  };
  let previewReady = false;
  let url;
  const previewStartedAt = readMonotonic(monotonicNow);
  try {
    const status = await (dependencies.previewStatus ?? previewStatus)(request.root);
    if (status.running && status.origin !== null) {
      url = new URL(route, status.origin).toString();
      previewReady = true;
    }
  } catch {
  }
  const previewResolutionMs = elapsedMonotonic(monotonicNow, previewStartedAt);
  const totalEndedAt = readMonotonic(monotonicNow);
  const actionTotalMs = assertNonnegativeDuration(totalEndedAt - actionStartedAt, "analysis total");
  const totalMs = request.commandStartedAt === void 0 ? assertNonnegativeDuration(parsingMs + actionTotalMs, "analysis total") : assertNonnegativeDuration(totalEndedAt - request.commandStartedAt, "analysis total");
  return {
    ...baseResult,
    previewReady,
    ...url === void 0 ? {} : { url },
    timings: {
      parsingMs,
      derivationMs,
      validationMs,
      publicationMs,
      previewResolutionMs,
      totalMs
    }
  };
}
function assertFinalizationInterval(capturedAt, finalizedAt) {
  const duration = Date.parse(finalizedAt) - Date.parse(capturedAt);
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error("review analysis finalization cannot precede the captured snapshot");
  }
  return duration;
}
function nondecreasingIsoTimestamp(minimum, candidate) {
  const minimumMs = Date.parse(minimum);
  const candidateMs = candidate.getTime();
  if (!Number.isFinite(minimumMs) || !Number.isFinite(candidateMs)) {
    throw new Error("review analysis finalization timestamps must be valid");
  }
  return new Date(Math.max(minimumMs, candidateMs)).toISOString();
}
function assertNonnegativeDuration(value, label) {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label} duration must be nonnegative`);
  return value;
}
function readMonotonic(clock) {
  const value = clock();
  if (!Number.isFinite(value)) throw new Error("analysis monotonic clock must be finite");
  return value;
}
function elapsedMonotonic(clock, startedAt) {
  return assertNonnegativeDuration(readMonotonic(clock) - startedAt, "analysis phase");
}
function measureMonotonic(clock, operation) {
  const startedAt = readMonotonic(clock);
  const value = operation();
  return { value, durationMs: elapsedMonotonic(clock, startedAt) };
}
function listReviews(root) {
  return createReviewStore(root).listWorkspaces();
}
async function openReview(root, reference, dependencies = {}) {
  createReviewStore(root).readBundle(reference.workspaceId, reference.revisionId);
  const status = await (dependencies.previewStatus ?? previewStatus)(root);
  if (!status.running || status.origin === null) throw new PreviewNotReadyError(root);
  return new URL(reviewUrl(reference), status.origin).toString();
}
function getReviewStatus(request) {
  const root = resolveRepositoryRoot(request.root, request.runner);
  const store = createReviewStore(root);
  const analysisFinalized = store.isAnalysisFinalized(
    request.reference.workspaceId,
    request.reference.revisionId
  );
  const bundle = store.readBundle(request.reference.workspaceId, request.reference.revisionId);
  const compare = request.compareSourceFreshness ?? compareReviewSourceFreshness2;
  const freshness = compare(bundle.snapshot, root, {
    runner: request.runner,
    readFile: request.readFile
  });
  const readiness = deriveReviewReadiness(
    {
      ...bundle,
      sourceChanged: freshness.sourceChanged
    },
    analysisFinalized
  );
  const excludes = bundle.snapshot.source.excludes;
  return {
    reference: formatReviewRef(request.reference.workspaceId, request.reference.revisionId),
    analysisRequired: !analysisFinalized,
    readiness,
    captureFailed: freshness.captureFailed,
    url: reviewUrl(request.reference),
    removals: removalsStatusFor(bundle),
    ...excludes && excludes.length > 0 ? { excludes } : {},
    ...bundle.snapshot.kind === "scope" ? { analysisGuidance: deriveReviewAnalysisGuidance(bundle.snapshot) } : {}
  };
}
function formatReviewStatusJson(request) {
  return JSON.stringify(getReviewStatus(request), null, 2);
}
function printReviewStatus(request) {
  const status = getReviewStatus(request);
  const state = status.analysisRequired ? "analysis required" : status.readiness.ready ? "ready" : "needs review";
  const sourceState = status.captureFailed ? "capture failed" : status.readiness.sourceChanged ? "changed" : "unchanged";
  const coveredRemovals = status.removals.filter((removal) => removal.covered).length;
  return [
    status.reference,
    state,
    `source: ${sourceState}`,
    `pending: ${status.readiness.pending}`,
    `stale: ${status.readiness.stale}`,
    `unanswered: ${status.readiness.unanswered}`,
    `removals: ${coveredRemovals}/${status.removals.length} explained`,
    ...status.excludes && status.excludes.length > 0 ? [`excludes: ${status.excludes.join(", ")}`] : [],
    `url: ${status.url}`
  ].join("\n");
}

// src/review-cli.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { readFileSync as readFileSync6 } from "node:fs";
import { performance as performance3 } from "node:perf_hooks";
import {
  assertSafeReviewSegment,
  claimQuestion,
  failQuestion,
  normalizeExcludes,
  parseReviewRef,
  writeAnswer
} from "@synergy/review-core";
import { bold as bold2, dim as dim3, green as green4, red, yellow as yellow2 } from "kleur/colors";

// src/feedback-wait.ts
import { LISTENING_FILE, REVIEW_DONE_FILE } from "@synergy/state";
import matter from "gray-matter";
function parseDuration(value) {
  const match = /^(\d+)([smh])$/.exec(value);
  if (!match) {
    throw new Error(`invalid duration "${value}" \u2014 use a number with s, m, or h (e.g. 10m)`);
  }
  const amount = Number(match[1]);
  if (amount <= 0) {
    throw new Error(`invalid duration "${value}" \u2014 must be greater than zero`);
  }
  const unitMs = match[2] === "s" ? 1e3 : match[2] === "m" ? 6e4 : 36e5;
  return amount * unitMs;
}

// src/review-wait.ts
import { watch } from "node:fs";
import {
  reconcileExpiredQuestions,
  removeReviewListener,
  reviewQuestionsDirectory,
  touchReviewListener
} from "@synergy/review-core";
var LISTENER_HEARTBEAT_MS = 3e4;
var WATCH_DEBOUNCE_MS = 60;
function retryableQuestions(root, reference) {
  return reconcileExpiredQuestions(root, reference).filter(
    (question) => question.status === "queued" || question.status === "failed"
  );
}
function waitForReviewQuestions(options) {
  const {
    root,
    reference,
    listenerId,
    timeoutMs,
    signal,
    watchImpl = watch,
    scanQuestions = retryableQuestions,
    touchListener = touchReviewListener,
    removeListener = removeReviewListener,
    heartbeatMs = LISTENER_HEARTBEAT_MS,
    beforeTimeoutScan
  } = options;
  const directory = reviewQuestionsDirectory(root, reference);
  let presenceTouched = false;
  try {
    touchListener(root, reference, listenerId);
    presenceTouched = true;
    const queued = scanQuestions(root, reference);
    if (queued.length > 0) {
      removeListener(root, reference, listenerId);
      return Promise.resolve({ status: "questions", listenerId, questions: queued });
    }
  } catch (error) {
    if (presenceTouched) {
      try {
        removeListener(root, reference, listenerId);
      } catch {
      }
    }
    return Promise.reject(error);
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let debounce;
    let timeoutTimer;
    let watcher;
    let heartbeat;
    const cleanup = () => {
      if (debounce) clearTimeout(debounce);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (heartbeat) clearInterval(heartbeat);
      signal?.removeEventListener("abort", onAbort);
      try {
        watcher?.close();
      } catch {
      }
      try {
        removeListener(root, reference, listenerId);
      } catch {
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };
    const fail2 = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    };
    const check = () => {
      try {
        const questions = scanQuestions(root, reference);
        if (questions.length > 0) finish({ status: "questions", listenerId, questions });
      } catch (error) {
        fail2(error);
      }
    };
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(check, WATCH_DEBOUNCE_MS);
    };
    const onAbort = () => finish({ status: "timeout", listenerId, questions: [] });
    const onTimeout = () => {
      if (debounce) clearTimeout(debounce);
      try {
        beforeTimeoutScan?.();
        const questions = scanQuestions(root, reference);
        finish(
          questions.length > 0 ? { status: "questions", listenerId, questions } : { status: "timeout", listenerId, questions: [] }
        );
      } catch (error) {
        fail2(error);
      }
    };
    try {
      watcher = watchImpl(directory, (_event, filename) => {
        if (filename?.toString().startsWith(".listeners")) return;
        schedule();
      });
      watcher.on("error", fail2);
      heartbeat = setInterval(() => {
        try {
          touchListener(root, reference, listenerId);
          check();
        } catch (error) {
          fail2(error);
        }
      }, heartbeatMs);
      heartbeat.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (timeoutMs !== void 0) timeoutTimer = setTimeout(onTimeout, timeoutMs);
      schedule();
    } catch (error) {
      fail2(error);
    }
  });
}

// src/review-cli.ts
var ReviewUsageError = class extends Error {
};
function excludesFromFlag(value) {
  if (value === void 0) return void 0;
  const raw = Array.isArray(value) ? value : [value];
  try {
    const normalized = normalizeExcludes(raw);
    return normalized.length > 0 ? normalized : void 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid exclude pattern";
    throw new ReviewUsageError(detail);
  }
}
function createReviewSourceFromFlags(flags) {
  const selected = [
    flags.pr !== void 0,
    flags.staged === true,
    flags.unstaged === true,
    flags.scope !== void 0
  ].filter(Boolean).length;
  if (selected !== 1) {
    throw new ReviewUsageError(
      "review create requires exactly one of --pr, --staged, --unstaged, or --scope"
    );
  }
  const excludes = excludesFromFlag(flags.exclude);
  if (flags.pr !== void 0) {
    return { kind: "pr", selector: flags.pr, ...excludes ? { excludes } : {} };
  }
  if (flags.staged) return { kind: "staged", ...excludes ? { excludes } : {} };
  if (flags.unstaged) return { kind: "unstaged", ...excludes ? { excludes } : {} };
  if (!flags.scope || flags.scope.trim().length === 0) {
    throw new ReviewUsageError("--scope cannot be empty");
  }
  return { kind: "scope", patterns: [flags.scope], ...excludes ? { excludes } : {} };
}
function printCreateResult(result, json) {
  const reference = `${result.reference.workspaceId}@${result.reference.revisionId}`;
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...result, reference }, null, 2)}
`);
    return;
  }
  const preparation = result.analysisRequired ? "analysis required" : "ready for review";
  const excludedLine = result.excludedFileCount && result.excludedFileCount > 0 ? `${dim3("Excluded:")} ${result.excludedFileCount} file${result.excludedFileCount === 1 ? "" : "s"} via ${result.excludes?.length ?? 0} pattern${result.excludes?.length === 1 ? "" : "s"}
` : "";
  process.stdout.write(
    `${green4("\u2713")} ${bold2(reference)} ${dim3(result.resumed ? "resumed" : "created")}
${dim3("Preparation:")} ${preparation}
${excludedLine}${dim3("Open:")} ${result.url}
`
  );
}
function printError(error, exitCode, json) {
  if (json && error instanceof PreviewNotReadyError) {
    process.stdout.write(
      `${JSON.stringify({ error: error.code, message: error.message, root: error.root, suggestedCommand: error.suggestedCommand })}
`
    );
    process.exitCode = exitCode;
    return;
  }
  const message = error instanceof Error ? error.message : "unexpected review command failure";
  process.stderr.write(`${red("Error:")} ${message}
`);
  process.exitCode = exitCode;
}
function parseUsageReviewRef(value) {
  try {
    return parseReviewRef(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid review reference";
    throw new ReviewUsageError(detail);
  }
}
function readUsageAnalysis(path) {
  try {
    const body = readFileSync6(path, "utf8");
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      throw new ReviewUsageError("$ must contain valid JSON");
    }
    return parseReviewAnalysisInput(value);
  } catch (error) {
    if (error instanceof ReviewUsageError) throw error;
    const detail = error instanceof Error ? error.message : "invalid analysis body";
    throw new ReviewUsageError(detail);
  }
}
function readUsageAnswer(path) {
  try {
    const body = readFileSync6(path, "utf8");
    if (body.trim().length === 0) throw new Error("answer body must not be empty");
    return body;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid answer body";
    throw new ReviewUsageError(`invalid answer body: ${detail}`);
  }
}
var REVIEW_ACTIONS = [
  "create",
  "refresh",
  "analysis-set",
  "list",
  "open",
  "status",
  "wait",
  "answer"
];
function assertKnownAction(action) {
  if (!REVIEW_ACTIONS.some((knownAction) => knownAction === action)) {
    throw new ReviewUsageError(
      "unknown review action \u2014 use create, refresh, analysis-set, list, open, status, wait, or answer"
    );
  }
}
function requireValidatedValue(value) {
  if (value === void 0) throw new Error("validated review command is missing required data");
  return value;
}
function assertKnownOptions(flags) {
  const known = /* @__PURE__ */ new Set([
    "root",
    "pr",
    "staged",
    "unstaged",
    "scope",
    "json",
    "bodyFile",
    "for",
    "review",
    "exclude",
    "--"
  ]);
  const unknown = Object.keys(flags).find((flag) => !known.has(flag));
  if (unknown) throw new ReviewUsageError(`unknown review option --${unknown}`);
  if (flags["--"] && flags["--"].length > 0) {
    throw new ReviewUsageError("review does not accept arguments after --");
  }
}
function assertReferenceCount(action, references, expected) {
  if (references.length === expected) return;
  if (expected === 0) throw new ReviewUsageError(`review ${action} does not accept a reference`);
  throw new ReviewUsageError(`review ${action} requires exactly one reference`);
}
function assertActionOptions(action, flags) {
  const hasSourceOption = flags.pr !== void 0 || flags.staged === true || flags.unstaged === true || flags.scope !== void 0;
  if (action !== "create" && hasSourceOption) {
    throw new ReviewUsageError(`review ${action} does not accept a source selector`);
  }
  if (action !== "create" && flags.exclude !== void 0) {
    throw new ReviewUsageError(`review ${action} does not accept --exclude`);
  }
  if (action !== "analysis-set" && action !== "answer" && flags.bodyFile !== void 0) {
    throw new ReviewUsageError(`review ${action} does not accept --body-file`);
  }
  if (action !== "wait" && flags.for !== void 0) {
    throw new ReviewUsageError(`review ${action} does not accept --for`);
  }
  if (action !== "answer" && flags.review !== void 0) {
    throw new ReviewUsageError(`review ${action} does not accept --review`);
  }
  if (action !== "create" && action !== "open" && action !== "status" && action !== "list" && action !== "analysis-set" && flags.json === true) {
    throw new ReviewUsageError(`review ${action} does not accept --json`);
  }
}
function parseUsageWorkspaceId(value) {
  try {
    assertSafeReviewSegment(value, "workspace");
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid workspace id";
    throw new ReviewUsageError(detail);
  }
}
function validateReviewCommand(actionValue, references, flags, monotonicNow = () => performance3.now()) {
  assertKnownAction(actionValue);
  assertKnownOptions(flags);
  assertActionOptions(actionValue, flags);
  switch (actionValue) {
    case "create":
      assertReferenceCount(actionValue, references, 0);
      return { action: actionValue, source: createReviewSourceFromFlags(flags) };
    case "refresh":
      assertReferenceCount(actionValue, references, 1);
      return { action: actionValue, workspaceId: parseUsageWorkspaceId(references[0] ?? "") };
    case "analysis-set":
      assertReferenceCount(actionValue, references, 1);
      if (!flags.bodyFile) throw new ReviewUsageError("review analysis-set requires --body-file");
      {
        const parsingStartedAt = monotonicNow();
        const analysis = readUsageAnalysis(flags.bodyFile);
        const analysisParsingMs = monotonicNow() - parsingStartedAt;
        if (!Number.isFinite(analysisParsingMs) || analysisParsingMs < 0) {
          throw new ReviewUsageError("analysis parsing duration must be nonnegative");
        }
        return {
          action: actionValue,
          reference: parseUsageReviewRef(references[0] ?? ""),
          analysis,
          analysisParsingMs
        };
      }
    case "list":
      assertReferenceCount(actionValue, references, 0);
      return { action: actionValue };
    case "open":
    case "status":
      assertReferenceCount(actionValue, references, 1);
      return { action: actionValue, reference: parseUsageReviewRef(references[0] ?? "") };
    case "wait": {
      assertReferenceCount(actionValue, references, 1);
      let timeoutMs;
      try {
        timeoutMs = flags.for ? parseDuration(flags.for) : void 0;
      } catch (error) {
        const detail = error instanceof Error ? error.message : "invalid wait duration";
        throw new ReviewUsageError(detail);
      }
      return {
        action: actionValue,
        reference: parseUsageReviewRef(references[0] ?? ""),
        ...timeoutMs === void 0 ? {} : { timeoutMs }
      };
    }
    case "answer": {
      assertReferenceCount(actionValue, references, 1);
      if (!flags.review) throw new ReviewUsageError("review answer requires --review");
      if (!flags.bodyFile) throw new ReviewUsageError("review answer requires --body-file");
      const questionId = references[0] ?? "";
      try {
        assertSafeReviewSegment(questionId, "question");
      } catch (error) {
        const detail = error instanceof Error ? error.message : "invalid question id";
        throw new ReviewUsageError(detail);
      }
      return {
        action: actionValue,
        questionId,
        reference: parseUsageReviewRef(flags.review),
        answerBody: readUsageAnswer(flags.bodyFile)
      };
    }
  }
}
async function runReviewWaitCommand(options) {
  const { root, reference, listenerId, timeoutMs, wait = waitForReviewQuestions } = options;
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    controller.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const result = await wait({
      root,
      reference,
      listenerId,
      timeoutMs,
      signal: controller.signal
    });
    return { result, interrupted };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
function registerReviewCommands(cli, dependencies = {}) {
  const open = dependencies.openReview ?? openReview;
  const applyAnalysis = dependencies.applyReviewAnalysis ?? applyReviewAnalysis;
  const monotonicNow = dependencies.monotonicNow ?? (() => performance3.now());
  cli.command("review <action> [...references]", "Manage local guided code reviews").option("--root <dir>", "Project root (default: cwd)").option("--pr <number-or-url>", "GitHub PR number or URL").option("--staged", "Review the Git index").option("--unstaged", "Review tracked worktree and non-ignored untracked changes").option(
    "--scope <path>",
    "Review tracked and non-ignored files under a repository-relative path"
  ).option(
    "--exclude <pattern>",
    "Repository-relative path pattern to exclude from the review (repeatable); create only"
  ).option("--json", "Print machine-readable output").option("--body-file <path>", "Analysis or answer body file").option("--for <duration>", "Bounded question wait, e.g. 90s, 10m, 1h").option("--review <reference>", "Review reference for review answer").allowUnknownOptions().action(async (action, references, flags) => {
    try {
      const commandStartedAt = monotonicNow();
      const command = validateReviewCommand(action, references, flags, monotonicNow);
      const root = resolveRepositoryRoot(flags.root ?? process.cwd());
      if (command.action === "create") {
        printCreateResult(
          createOrResumeReview({ root, source: requireValidatedValue(command.source) }),
          flags.json
        );
        return;
      }
      if (command.action === "refresh") {
        printCreateResult(
          refreshReview({ root, workspaceId: requireValidatedValue(command.workspaceId) }),
          flags.json
        );
        return;
      }
      if (command.action === "analysis-set") {
        const result = await applyAnalysis(
          {
            root,
            reference: requireValidatedValue(command.reference),
            analysis: requireValidatedValue(command.analysis),
            parsingInMs: command.analysisParsingMs,
            commandStartedAt
          },
          { monotonicNow }
        );
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
          return;
        }
        const destination = result.previewReady ? result.url : result.route;
        process.stdout.write(
          `${green4("\u2713")} analysis recorded for ${bold2(result.reference)}
${dim3("Analysis interval:")} ${result.analysisFinalizedInMs}ms
${dim3("Tool timing:")} ${result.timings.totalMs}ms
${dim3(result.previewReady ? "Open:" : "Route:")} ${destination}
`
        );
        return;
      }
      if (command.action === "list") {
        const workspaces = listReviews(root);
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(workspaces, null, 2)}
`);
          return;
        }
        if (workspaces.length === 0) {
          process.stdout.write(`${dim3("No local review workspaces found.")}
`);
          return;
        }
        for (const workspace of workspaces) {
          process.stdout.write(
            `${bold2(workspace.id)} ${dim3("\u203A")} ${workspace.currentRevisionId} ${yellow2(workspace.source.kind)}
`
          );
        }
        return;
      }
      if (command.action === "open") {
        const reference = requireValidatedValue(command.reference);
        const url = await open(root, reference);
        process.stdout.write(
          flags.json ? `${JSON.stringify({ reference: references[0], url })}
` : `${url}
`
        );
        return;
      }
      if (command.action === "status") {
        const reviewRef = requireValidatedValue(command.reference);
        process.stdout.write(
          `${flags.json ? formatReviewStatusJson({ root, reference: reviewRef }) : printReviewStatus({ root, reference: reviewRef })}
`
        );
        return;
      }
      if (command.action === "wait") {
        const reference = requireValidatedValue(command.reference);
        const listenerId = randomUUID4();
        const { result, interrupted } = await runReviewWaitCommand({
          root,
          reference,
          listenerId,
          timeoutMs: command.timeoutMs
        });
        if (interrupted) {
          process.exitCode = 130;
          return;
        }
        process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
        return;
      }
      if (command.action === "answer") {
        const reference = requireValidatedValue(command.reference);
        const questionId = requireValidatedValue(command.questionId);
        const listenerId = randomUUID4();
        const now = Date.now();
        const claim = claimQuestion(root, reference, questionId, listenerId, now, 5 * 6e4);
        const claimToken = claim.question?.claim?.token;
        if (!claim.ok || !claimToken)
          throw new Error("review question is already claimed or answered");
        try {
          const answer = writeAnswer(
            root,
            reference,
            questionId,
            listenerId,
            claimToken,
            requireValidatedValue(command.answerBody),
            Date.now()
          );
          process.stdout.write(
            `${JSON.stringify({ question: answer.questionId, answer }, null, 2)}
`
          );
        } catch (error) {
          failQuestion(
            root,
            reference,
            questionId,
            listenerId,
            claimToken,
            "Answer generation failed.",
            Date.now()
          );
          throw error;
        }
        return;
      }
    } catch (error) {
      printError(error, error instanceof ReviewUsageError ? 2 : 1, flags.json);
    }
  });
}
export {
  PREVIEW_PORT,
  applyReviewAnalysis,
  capturePr,
  captureReviewSource,
  captureScope,
  captureStaged,
  captureUnstaged,
  createOrResumeReview,
  createReviewSourceFromFlags,
  formatReviewStatusJson,
  getReviewStatus,
  initProject,
  listReviews,
  logFinding,
  openReview,
  parseReviewAnalysisInput,
  phaseSet,
  previewStart,
  previewStatus,
  previewStop,
  printProgress,
  printReviewStatus,
  printStatus,
  refreshReview,
  registerReviewCommands,
  resolveProjectPaths,
  resumeSet
};
//# sourceMappingURL=index.js.map