#!/usr/bin/env node

// src/cli.ts
import { readFileSync as readFileSync7, rmSync as rmSync3 } from "node:fs";
import { join as join6, resolve as resolve2 } from "node:path";
import cac from "cac";
import { bold as bold3, dim as dim4, green as green5, red as red3, yellow as yellow3 } from "kleur/colors";

// src/preview.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import {
  constants as constants3,
  closeSync as closeSync4,
  copyFileSync as copyFileSync3,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync as openSync4,
  readFileSync as readFileSync3,
  readSync,
  realpathSync,
  renameSync as renameSync3,
  unlinkSync as unlinkSync3
} from "node:fs";
import { dim, green, yellow } from "kleur/colors";

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

// src/preview-lock.ts
import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  copyFileSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
var DEFAULT_DEPENDENCIES = {
  copyFileExclusive: (source, destination) => copyFileSync(source, destination, constants.COPYFILE_EXCL),
  createQuarantineId: randomUUID,
  now: () => performance.now(),
  publishOwnerRecord: (source, destination) => renameSync(source, destination),
  unlinkFile: unlinkSync,
  wallNow: Date.now,
  sleep: (milliseconds) => new Promise((resolve3) => setTimeout(resolve3, milliseconds))
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasErrorCode(error, code) {
  return isRecord(error) && error.code === code;
}
function readLockRecord(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
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
  return readdirSync(directory).filter((entry) => entry.startsWith(prefix)).map((entry) => join(directory, entry));
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
  return new Promise((resolve3, reject) => {
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
      else resolve3(result);
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
  return new Promise((resolve3, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error === void 0) resolve3();
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
  return new Promise((resolve3) => {
    let settled = false;
    let timer = null;
    const finish = (didExit) => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      child.removeListener("exit", onExit);
      resolve3(didExit);
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
  readFileSync as readFileSync2,
  readdirSync as readdirSync2,
  renameSync as renameSync2,
  unlinkSync as unlinkSync2,
  writeSync
} from "node:fs";
import { basename as basename2, dirname as dirname2, join as join2 } from "node:path";
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
    return readdirSync2(directory).filter((entry) => entry.startsWith(prefix)).map((entry) => join2(directory, entry));
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
    return parsePreviewRuntime(JSON.parse(readFileSync2(path, "utf8")));
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
  const tempPath = join2(dirname2(path), `.${basename2(path)}.${process.pid}.${randomUUID2()}.tmp`);
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
  return new Promise((resolve3) => {
    const controller = new AbortController();
    let settled = false;
    let timer = null;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      resolve3(outcome);
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
  return new Promise((resolve3) => {
    let settled = false;
    let timer = null;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      resolve3(outcome);
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
var SYNERGY_VERSION = "0.12.1";

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
  sleep: (milliseconds) => new Promise((resolve3) => setTimeout(resolve3, milliseconds)),
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
  if (!existsSync(pidFile)) return;
  let pid = null;
  try {
    const raw = readFileSync3(pidFile, "utf8").trim();
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
  if (!existsSync(path)) return "";
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
  mkdirSync(paths.synergyDir, { recursive: true });
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
        `${green("\u2713")} Preview started (pid ${finalizedRuntime.pid}) at ${dim(finalizedRuntime.origin)}
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
          dependencies.writeOutput(`${green("\u2713")} Preview stopped (pid ${runtime.pid})
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
    process.stdout.write(`${green("\u25CF")} running  pid ${status.pid}  ${status.origin}
`);
  } else {
    process.stdout.write(`${dim("\u25CB")} stopped
`);
  }
}

// src/daemon.ts
async function tryDaemon(root, method, path, body) {
  const status = await previewStatus(root);
  if (!status.running || status.origin === null) return null;
  const url = `${status.origin}${path}`;
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: body === void 0 ? void 0 : { "content-type": "application/json" },
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
  } catch {
    return null;
  }
  const text = await resp.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!resp.ok) {
    const detail = parsed.detail ?? `HTTP ${resp.status}`;
    throw new Error(detail);
  }
  return parsed;
}

// src/execstate.ts
import { existsSync as existsSync2 } from "node:fs";
import { join as join3 } from "node:path";
import {
  appendFinding,
  deriveProgress,
  readProgress,
  setPhaseStatus,
  setResume,
  writeHandoff
} from "@synergy/state";
import { bold, dim as dim2, green as green2 } from "kleur/colors";
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
  const dir = join3(paths.sessionsDir, session);
  if (!existsSync2(dir)) {
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
    `${green2("\u2713")} ${args.session} ${dim2("\u203A")} phase ${bold(args.phaseId)} \u2192 ${args.status}
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
  process.stdout.write(`${green2("\u2713")} logged finding to ${dim2(where)}
`);
}
function resumeSet(args) {
  const sessionDir = resolveSessionDir(args.root, args.session);
  setResume(sessionDir, { nextPhase: args.next, note: args.note });
  process.stdout.write(`${green2("\u2713")} resume \u2192 ${bold(args.next ?? "(unset)")}
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
function handoffSet(args) {
  const sessionDir = resolveSessionDir(args.root, args.session);
  writeHandoff(sessionDir, args.body);
  const stamp = (/* @__PURE__ */ new Date()).toISOString();
  setResume(sessionDir, {
    nextPhase: args.next,
    note: `See .state/handoff.md (captured ${stamp})`
  });
  process.stdout.write(`${green2("\u2713")} handoff written \u2192 ${dim2(".state/handoff.md")}
`);
}

// src/feedback-wait.ts
import {
  existsSync as existsSync3,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync4,
  readdirSync as readdirSync3,
  rmSync as rmSync2,
  watch,
  writeFileSync as writeFileSync2
} from "node:fs";
import { join as join4 } from "node:path";
import { LISTENING_FILE, REVIEW_DONE_FILE } from "@synergy/state";
import matter from "gray-matter";
var LISTENING_HEARTBEAT_MS = 3e4;
function scanOpenComments(feedbackDir, session) {
  const sessionDir = join4(feedbackDir, session);
  if (!existsSync3(sessionDir)) return [];
  const comments = [];
  for (const filename of readdirSync3(sessionDir)) {
    if (!filename.endsWith(".md")) continue;
    try {
      const raw = readFileSync4(join4(sessionDir, filename), "utf8");
      const parsed = matter(raw);
      const data = parsed.data;
      if (data.status !== "open") continue;
      comments.push({
        ...data,
        body: parsed.content.trim()
      });
    } catch {
    }
  }
  comments.sort((a, b) => a.created < b.created ? -1 : a.created > b.created ? 1 : 0);
  return comments;
}
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
var WATCH_DEBOUNCE_MS = 60;
function waitForFeedback(options) {
  const { feedbackDir, session, timeoutMs, watchImpl = watch } = options;
  const sessionDir = join4(feedbackDir, session);
  mkdirSync2(sessionDir, { recursive: true });
  const doneFile = join4(sessionDir, REVIEW_DONE_FILE);
  rmSync2(doneFile, { force: true });
  const queued = scanOpenComments(feedbackDir, session);
  if (queued.length > 0) {
    return Promise.resolve({ status: "feedback", comments: queued });
  }
  const listeningFile = join4(sessionDir, LISTENING_FILE);
  const touchListening = () => {
    try {
      writeFileSync2(listeningFile, `${(/* @__PURE__ */ new Date()).toISOString()}
`, "utf8");
    } catch {
    }
  };
  touchListening();
  const listeningHeartbeat = setInterval(touchListening, LISTENING_HEARTBEAT_MS);
  listeningHeartbeat.unref?.();
  return new Promise((resolvePromise) => {
    let settled = false;
    let debounce;
    let timeoutTimer;
    const watcher = watchImpl(sessionDir, (_event, filename) => {
      if (filename?.toString() === LISTENING_FILE) return;
      schedule();
    });
    watcher.on("error", () => {
      finish({ status: "timeout", comments: [] });
    });
    const cleanup = () => {
      if (debounce) clearTimeout(debounce);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      clearInterval(listeningHeartbeat);
      rmSync2(listeningFile, { force: true });
      watcher.close();
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };
    const check = () => {
      if (settled) return;
      const open = scanOpenComments(feedbackDir, session);
      if (existsSync3(doneFile)) {
        rmSync2(doneFile, { force: true });
        finish({ status: "ended", comments: open });
        return;
      }
      if (open.length > 0) {
        finish({ status: "feedback", comments: open });
      }
    };
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(check, WATCH_DEBOUNCE_MS);
    };
    if (timeoutMs !== void 0) {
      timeoutTimer = setTimeout(() => finish({ status: "timeout", comments: [] }), timeoutMs);
    }
    schedule();
  });
}

// src/init.ts
import { appendFileSync, existsSync as existsSync4, mkdirSync as mkdirSync3, readFileSync as readFileSync5 } from "node:fs";
import { join as join5 } from "node:path";
import { green as green3 } from "kleur/colors";
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
  mkdirSync3(paths.synergyDir, { recursive: true });
  const gitignorePath = join5(paths.synergyDir, ".gitignore");
  const current = existsSync4(gitignorePath) ? readFileSync5(gitignorePath, "utf8") : "";
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
  mkdirSync3(paths.sessionsDir, { recursive: true });
  ensureSynergyGitignore(paths.root);
  process.stdout.write(`${green3("\u2713")} Initialized .synergy/ in ${paths.root}
`);
  return { synergyDir: paths.synergyDir };
}

// src/preview-cli.ts
import { red } from "kleur/colors";
var PreviewUsageError = class extends Error {
};
function parsePort(value) {
  if (value === void 0) return void 0;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new PreviewUsageError("--port must be an integer from 1 to 65535");
  }
  return port;
}
function registerPreviewCommand(cli2, dependencyOverrides = {}) {
  const dependencies = {
    previewStart,
    previewStatus,
    previewStop,
    printStatus,
    ...dependencyOverrides
  };
  cli2.command("preview <action>", "Manage the preview server (start | stop | status)").option("--root <dir>", "Project root (default: cwd)").option("--port <port>", "Require a specific port (default: prefer 4321)").option("--json", "Print machine-readable JSON").action(async (action, flags) => {
    try {
      if (action !== "start" && action !== "stop" && action !== "status") {
        throw new PreviewUsageError(`unknown action "${action}" \u2014 use start | stop | status`);
      }
      if (flags.port !== void 0 && action !== "start") {
        throw new PreviewUsageError("--port is only supported for preview start");
      }
      if (action === "start") {
        const port = parsePort(flags.port);
        const status2 = await dependencies.previewStart({
          root: flags.root,
          ...flags.json ? { quiet: true } : {},
          ...port === void 0 ? {} : { port }
        });
        if (flags.json) process.stdout.write(`${JSON.stringify(status2, null, 2)}
`);
        return;
      }
      if (action === "stop") {
        const stopped = flags.json ? await dependencies.previewStop(flags.root, { quiet: true }) : await dependencies.previewStop(flags.root);
        if (!stopped) {
          throw new Error("Preview shutdown could not be confirmed");
        }
        if (flags.json) process.stdout.write(`${JSON.stringify({ stopped: true })}
`);
        return;
      }
      const status = await dependencies.previewStatus(flags.root);
      if (flags.json) process.stdout.write(`${JSON.stringify(status, null, 2)}
`);
      else dependencies.printStatus(status);
    } catch (error) {
      const exitCode = error instanceof PreviewUsageError ? 2 : 1;
      const message = error instanceof Error ? error.message : "unexpected preview command failure";
      process.stderr.write(`${red("Error:")} ${message}
`);
      process.exitCode = exitCode;
    }
  });
}

// src/review-cli.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { readFileSync as readFileSync6 } from "node:fs";
import {
  assertSafeReviewSegment,
  claimQuestion,
  failQuestion,
  parseReviewRef,
  writeAnswer
} from "@synergy/review-core";
import { bold as bold2, dim as dim3, green as green4, red as red2, yellow as yellow2 } from "kleur/colors";

// src/review-actions.ts
import {
  applyCodeSections,
  buildDiffSnapshot,
  buildScopeSnapshot,
  compareReviewSourceFreshness as compareReviewSourceFreshness2,
  createReviewStore,
  deriveReviewReadiness,
  formatReviewRef,
  hashText,
  isReviewCoreError,
  reconcileReview
} from "@synergy/review-core";

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
var GROUP_ID = /^[a-z0-9][a-z0-9_-]*$/u;
var MAX_DESCRIPTION_LENGTH = 600;
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
function resultFor(root, reference, resumed) {
  const store = createReviewStore(root);
  store.readBundle(reference.workspaceId, reference.revisionId);
  return {
    reference,
    resumed,
    url: reviewUrl(reference),
    analysisRequired: !store.isAnalysisFinalized(reference.workspaceId, reference.revisionId)
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
    return resultFor(root, { workspaceId, revisionId: existingRevision }, true);
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
  const insights = { schemaVersion: 1, revisionId, groups: [], items: [] };
  const progress = existingWorkspace ? reconcileReview(
    store.readBundle(workspaceId, existingWorkspace.currentRevisionId),
    snapshot,
    now
  ) : initialProgress(snapshot, now);
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
    return resultFor(root, { workspaceId, revisionId: concurrentRevision }, true);
  }
  return resultFor(root, { workspaceId, revisionId }, false);
}
function captureRequestFromWorkspace(workspace) {
  switch (workspace.source.kind) {
    case "pr":
      return { kind: "pr", selector: workspace.source.url };
    case "staged":
      return { kind: "staged" };
    case "unstaged":
      return { kind: "unstaged" };
    case "scope":
      return { kind: "scope", patterns: workspace.source.patterns };
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
function assertSafeEvidencePath(path) {
  if (path.length === 0 || path.includes("\0") || path.startsWith("/") || path.startsWith("\\") || path.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")) {
    throw new Error(`invalid evidence path: ${path}`);
  }
}
function assertValidAnalysis(snapshot, analysis) {
  const itemIds = new Set(snapshot.items.map((item) => item.id));
  const groupIds = /* @__PURE__ */ new Set();
  const groupedItemIds = /* @__PURE__ */ new Set();
  for (const group of analysis.groups) {
    if (!GROUP_ID.test(group.id)) throw new Error(`invalid review group id: ${group.id}`);
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
    if (insight.description.trim().length === 0 || insight.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`review item description must be 1-${MAX_DESCRIPTION_LENGTH} characters`);
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
}
function applyReviewAnalysis(request) {
  const store = createReviewStore(request.root);
  const bundle = store.readBundle(request.reference.workspaceId, request.reference.revisionId);
  if (store.isAnalysisFinalized(request.reference.workspaceId, request.reference.revisionId)) {
    throw new Error("review analysis already exists and is immutable");
  }
  const insights = {
    schemaVersion: 1,
    revisionId: request.reference.revisionId,
    groups: request.analysis.groups,
    items: request.analysis.items
  };
  if (bundle.snapshot.kind === "scope") {
    if (!request.analysis.sections)
      throw new Error("scoped review analysis requires proposed code sections");
    if (request.analysis.sections.length === 0) {
      throw new Error("scoped review analysis requires at least one code section");
    }
    const snapshot = applyCodeSections(bundle.snapshot, request.analysis.sections);
    assertValidAnalysis(snapshot, request.analysis);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const progress = bundle.snapshot.predecessorRevisionId ? reconcileReview(
      store.readBundle(request.reference.workspaceId, bundle.snapshot.predecessorRevisionId),
      snapshot,
      now
    ) : initialProgress(snapshot, now);
    store.finalizeScopeAnalysis(
      request.reference.workspaceId,
      request.reference.revisionId,
      snapshot,
      insights,
      progress
    );
  } else {
    if (request.analysis.sections)
      throw new Error("diff review analysis cannot define code sections");
    assertValidAnalysis(bundle.snapshot, request.analysis);
    store.writeInitialInsights(
      request.reference.workspaceId,
      request.reference.revisionId,
      insights
    );
  }
  return request.reference;
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
  return {
    reference: formatReviewRef(request.reference.workspaceId, request.reference.revisionId),
    analysisRequired: !analysisFinalized,
    readiness,
    captureFailed: freshness.captureFailed,
    url: reviewUrl(request.reference)
  };
}
function formatReviewStatusJson(request) {
  return JSON.stringify(getReviewStatus(request), null, 2);
}
function printReviewStatus(request) {
  const status = getReviewStatus(request);
  const state = status.analysisRequired ? "analysis required" : status.readiness.ready ? "ready" : "needs review";
  const sourceState = status.captureFailed ? "capture failed" : status.readiness.sourceChanged ? "changed" : "unchanged";
  return [
    status.reference,
    state,
    `source: ${sourceState}`,
    `pending: ${status.readiness.pending}`,
    `stale: ${status.readiness.stale}`,
    `unanswered: ${status.readiness.unanswered}`,
    `url: ${status.url}`
  ].join("\n");
}

// src/review-wait.ts
import { watch as watch2 } from "node:fs";
import {
  reconcileExpiredQuestions,
  removeReviewListener,
  reviewQuestionsDirectory,
  touchReviewListener
} from "@synergy/review-core";
var LISTENER_HEARTBEAT_MS = 3e4;
var WATCH_DEBOUNCE_MS2 = 60;
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
    watchImpl = watch2,
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
    const fail = (error) => {
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
        fail(error);
      }
    };
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(check, WATCH_DEBOUNCE_MS2);
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
        fail(error);
      }
    };
    try {
      watcher = watchImpl(directory, (_event, filename) => {
        if (filename?.toString().startsWith(".listeners")) return;
        schedule();
      });
      watcher.on("error", fail);
      heartbeat = setInterval(() => {
        try {
          touchListener(root, reference, listenerId);
          check();
        } catch (error) {
          fail(error);
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
      fail(error);
    }
  });
}

// src/review-cli.ts
var ReviewUsageError = class extends Error {
};
function isRecord6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isReviewInsightConfidence(value) {
  return value === "high" || value === "medium" || value === "low";
}
function isIntegerNumber(value) {
  return typeof value === "number" && Number.isInteger(value);
}
function readAnalysis(body) {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("analysis body must contain valid JSON");
  }
  if (!isRecord6(value) || !Array.isArray(value.groups) || !Array.isArray(value.items)) {
    throw new Error("analysis body must include groups and items arrays");
  }
  const groups = value.groups.map((group) => {
    if (!isRecord6(group) || typeof group.id !== "string" || typeof group.label !== "string" || !Array.isArray(group.reviewItemIds) || !group.reviewItemIds.every((item) => typeof item === "string")) {
      throw new Error("analysis groups must contain id, label, and reviewItemIds");
    }
    return { id: group.id, label: group.label, reviewItemIds: group.reviewItemIds };
  });
  const items = value.items.map((item) => {
    if (!isRecord6(item) || typeof item.reviewItemId !== "string" || typeof item.description !== "string" || !isReviewInsightConfidence(item.confidence) || !Array.isArray(item.evidencePaths) || !item.evidencePaths.every((path) => typeof path === "string")) {
      throw new Error(
        "analysis items must contain reviewItemId, description, confidence, and evidencePaths"
      );
    }
    const confidence = item.confidence;
    return {
      reviewItemId: item.reviewItemId,
      description: item.description,
      confidence,
      evidencePaths: item.evidencePaths
    };
  });
  let sections;
  if (value.sections !== void 0) {
    if (!Array.isArray(value.sections)) throw new Error("analysis sections must be an array");
    sections = value.sections.map((section) => {
      if (!isRecord6(section) || typeof section.path !== "string" || typeof section.label !== "string" || !isIntegerNumber(section.start) || !isIntegerNumber(section.end) || section.parentLabel !== void 0 && typeof section.parentLabel !== "string") {
        throw new Error("analysis sections must contain path, label, start, and end");
      }
      return {
        path: section.path,
        label: section.label,
        start: section.start,
        end: section.end,
        ...section.parentLabel === void 0 ? {} : { parentLabel: section.parentLabel }
      };
    });
  }
  return { groups, items, ...sections === void 0 ? {} : { sections } };
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
  if (flags.pr !== void 0) return { kind: "pr", selector: flags.pr };
  if (flags.staged) return { kind: "staged" };
  if (flags.unstaged) return { kind: "unstaged" };
  if (!flags.scope || flags.scope.trim().length === 0) {
    throw new ReviewUsageError("--scope cannot be empty");
  }
  return { kind: "scope", patterns: [flags.scope] };
}
function printCreateResult(result, json) {
  const reference = `${result.reference.workspaceId}@${result.reference.revisionId}`;
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...result, reference }, null, 2)}
`);
    return;
  }
  const preparation = result.analysisRequired ? "analysis required" : "ready for review";
  process.stdout.write(
    `${green4("\u2713")} ${bold2(reference)} ${dim3(result.resumed ? "resumed" : "created")}
${dim3("Preparation:")} ${preparation}
${dim3("Open:")} ${result.url}
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
  process.stderr.write(`${red2("Error:")} ${message}
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
    return readAnalysis(readFileSync6(path, "utf8"));
  } catch (error) {
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
  if (action !== "analysis-set" && action !== "answer" && flags.bodyFile !== void 0) {
    throw new ReviewUsageError(`review ${action} does not accept --body-file`);
  }
  if (action !== "wait" && flags.for !== void 0) {
    throw new ReviewUsageError(`review ${action} does not accept --for`);
  }
  if (action !== "answer" && flags.review !== void 0) {
    throw new ReviewUsageError(`review ${action} does not accept --review`);
  }
  if (action !== "create" && action !== "open" && action !== "status" && action !== "list" && flags.json === true) {
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
function validateReviewCommand(actionValue, references, flags) {
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
      return {
        action: actionValue,
        reference: parseUsageReviewRef(references[0] ?? ""),
        analysis: readUsageAnalysis(flags.bodyFile)
      };
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
function registerReviewCommands(cli2, dependencies = {}) {
  const open = dependencies.openReview ?? openReview;
  cli2.command("review <action> [...references]", "Manage local guided code reviews").option("--root <dir>", "Project root (default: cwd)").option("--pr <number-or-url>", "GitHub PR number or URL").option("--staged", "Review the Git index").option("--unstaged", "Review tracked worktree and non-ignored untracked changes").option(
    "--scope <path>",
    "Review tracked and non-ignored files under a repository-relative path"
  ).option("--json", "Print machine-readable output").option("--body-file <path>", "Analysis or answer body file").option("--for <duration>", "Bounded question wait, e.g. 90s, 10m, 1h").option("--review <reference>", "Review reference for review answer").allowUnknownOptions().action(async (action, references, flags) => {
    try {
      const command = validateReviewCommand(action, references, flags);
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
        applyReviewAnalysis({
          root,
          reference: requireValidatedValue(command.reference),
          analysis: requireValidatedValue(command.analysis)
        });
        process.stdout.write(
          `${green4("\u2713")} analysis recorded for ${bold2(references[0] ?? "")}
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

// src/cli.ts
var cli = cac("synergy");
cli.help();
cli.version(SYNERGY_VERSION);
cli.command("init", "Scaffold .synergy/ in the current directory").option("--root <dir>", "Project root (default: cwd)").action((flags) => {
  initProject(flags.root);
});
registerPreviewCommand(cli);
var HEARTBEAT_MS = 3e4;
function feedbackNextStep(result, session) {
  if (result.status === "ended") {
    return "The user finished reviewing. Address any comments in this final batch (edit the referenced spec locations, then resolve or reject each comment), report back in the conversation, and do NOT re-run `synergy feedback wait` \u2014 the review session is over.";
  }
  if (result.status === "timeout") {
    return `No feedback arrived before the timeout. Return to the conversation; re-run \`synergy feedback wait ${session}\` only when the user says they are reviewing again.`;
  }
  return `Address each comment: edit the referenced spec location, then resolve or reject the comment (POST /api/feedback/resolve-batch when the preview is up, frontmatter edit otherwise). After resolving, re-run \`synergy feedback wait ${session}\` to keep listening \u2014 the user sees your resolutions live.`;
}
cli.command("feedback <action> <session>", "Wait for review comments (action: wait)").option("--root <dir>", "Project root (default: cwd)").option("--for <duration>", "Bounded wait, e.g. 90s, 10m, 1h (default: wait indefinitely)").action(async (action, session, flags) => {
  if (action !== "wait") {
    process.stderr.write(`${red3("Error:")} unknown feedback action "${action}" \u2014 use wait
`);
    process.exit(2);
  }
  let timeoutMs;
  try {
    timeoutMs = flags.for ? parseDuration(flags.for) : void 0;
  } catch (err) {
    process.stderr.write(`${red3("Error:")} ${err.message}
`);
    process.exit(2);
  }
  if (session.includes("..") || session.includes("/") || session.includes("\\")) {
    process.stderr.write(`${red3("Error:")} session must be a single directory name
`);
    process.exit(2);
  }
  const { feedbackDir } = resolveProjectPaths(flags.root);
  process.stderr.write(
    `${dim4("[synergy]")} Waiting for review comments on ${bold3(session)}. Stays silent until the user queues a comment or clicks "Done reviewing" \u2014 leave it running.
${dim4("[synergy]")} If this gets killed, re-run \`synergy feedback wait ${session}\` \u2014 comments persist on disk and are never lost.
`
  );
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1e3);
    process.stderr.write(`${dim4(`[synergy] still waiting (${elapsed}s elapsed)\u2026`)}
`);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const onSignal = (signal) => {
    rmSync3(join6(feedbackDir, session, LISTENING_FILE), { force: true });
    process.stderr.write(
      `
${dim4("[synergy]")} Wait interrupted. Re-run \`synergy feedback wait ${session}\` to resume; queued comments persist.
`
    );
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const result = await waitForFeedback({ feedbackDir, session, timeoutMs });
  clearInterval(heartbeat);
  process.stdout.write(
    `${JSON.stringify({ ...result, next_step: feedbackNextStep(result, session) }, null, 2)}
`
  );
});
cli.command("validate [session]", "Validate one or all sessions").option("--root <dir>", "Project root (default: cwd)").action(async (session, flags) => {
  const projectRoot = resolve2(flags.root ?? process.cwd());
  const query = session ? `?session=${encodeURIComponent(session)}` : "";
  let report = null;
  try {
    const fromDaemon = await tryDaemon(flags.root, "GET", `/api/validate${query}`);
    if (fromDaemon && Array.isArray(fromDaemon.issues)) {
      report = fromDaemon;
    }
  } catch {
  }
  if (!report) {
    const { validate } = await import("@synergy/validator");
    report = validate({ projectRoot, session });
  }
  const errors = report.issues.filter((i) => i.severity === "error");
  const warnings = report.issues.filter((i) => i.severity === "warning");
  for (const issue of report.issues) {
    const tag = issue.severity === "error" ? red3("error") : yellow3("warn");
    const loc = `${issue.file.replace(`${projectRoot}/`, "")}${issue.line ? `:${issue.line}` : ""}`;
    const comp = issue.component ? dim4(`[${issue.component}] `) : "";
    process.stdout.write(`${tag} ${dim4(loc)}
  ${comp}${issue.message}
`);
  }
  const summary = `${bold3(`${report.sessionsChecked} session(s)`)}, ${report.filesChecked} file(s), ${errors.length} error(s), ${warnings.length} warning(s)`;
  process.stdout.write(`
${errors.length === 0 ? green5("\u2713") : red3("\u2717")} ${summary}
`);
  process.exit(errors.length > 0 ? 1 : 0);
});
cli.command("phase <action> <session> <phaseId> [status]", "Set a phase status (action: set)").option("--root <dir>", "Project root (default: cwd)").option("--note <text>", "Boundary note appended to the phase journal").action(
  async (action, session, phaseId, status, flags) => {
    if (action !== "set") {
      process.stderr.write(`${red3("Error:")} unknown phase action "${action}" \u2014 use set
`);
      process.exit(2);
    }
    if (!status) {
      process.stderr.write(`${red3("Error:")} phase set requires a <status> argument
`);
      process.exit(2);
    }
    try {
      const viaDaemon = await tryDaemon(flags.root, "POST", "/api/phase", {
        session,
        phaseId,
        status,
        note: flags.note
      });
      if (viaDaemon) {
        process.stdout.write(
          `${green5("\u2713")} ${session} ${dim4("\u203A")} phase ${bold3(phaseId)} \u2192 ${status}
`
        );
      } else {
        phaseSet({
          root: flags.root,
          session,
          phaseId,
          status,
          note: flags.note
        });
      }
    } catch (err) {
      process.stderr.write(`${red3("Error:")} ${err.message}
`);
      process.exit(1);
    }
  }
);
cli.command("log <session> <text>", "Append a finding to a phase journal or the global journal").option("--root <dir>", "Project root (default: cwd)").option("--phase <id>", "Phase slug to attach the finding to").option("--global", "Record a cross-cutting finding in journal.md").action(
  async (session, text, flags) => {
    try {
      const viaDaemon = await tryDaemon(flags.root, "POST", "/api/log", {
        session,
        text,
        phase: flags.phase,
        global: flags.global
      });
      if (viaDaemon) {
        process.stdout.write(
          `${green5("\u2713")} logged finding to ${dim4(flags.global ? "global" : `phase ${flags.phase}`)}
`
        );
      } else {
        logFinding({ root: flags.root, session, text, phase: flags.phase, global: flags.global });
      }
    } catch (err) {
      process.stderr.write(`${red3("Error:")} ${err.message}
`);
      process.exit(1);
    }
  }
);
cli.command("continue <session>", "Set the resume pointer (where a fresh agent should start)").option("--root <dir>", "Project root (default: cwd)").option("--next <phaseId>", "Phase slug to resume from").option("--note <text>", "Free-text start-here note").action(async (session, flags) => {
  try {
    const viaDaemon = await tryDaemon(flags.root, "POST", "/api/resume", {
      session,
      next: flags.next,
      note: flags.note
    });
    if (viaDaemon) {
      process.stdout.write(`${green5("\u2713")} resume \u2192 ${bold3(flags.next ?? "(unset)")}
`);
    } else {
      resumeSet({ root: flags.root, session, next: flags.next, note: flags.note });
    }
  } catch (err) {
    process.stderr.write(`${red3("Error:")} ${err.message}
`);
    process.exit(1);
  }
});
cli.command("status <session>", "Print the execution-state rollup for a session").option("--root <dir>", "Project root (default: cwd)").action((session, flags) => {
  try {
    process.stdout.write(`${printProgress({ root: flags.root, session })}
`);
  } catch (err) {
    process.stderr.write(`${red3("Error:")} ${err.message}
`);
    process.exit(1);
  }
});
cli.command("handoff <session>", "Write the KT handoff baton (.state/handoff.md) + resume pointer").option("--root <dir>", "Project root (default: cwd)").option("--next <phaseId>", "Phase slug the next agent should resume from").option("--body <text>", "Handoff markdown body (inline)").option("--body-file <path>", "Read the handoff markdown body from a file").action(
  async (session, flags) => {
    try {
      const body = flags.bodyFile ? readFileSync7(flags.bodyFile, "utf8") : flags.body ?? "";
      if (!body.trim()) {
        process.stderr.write(`${red3("Error:")} handoff needs --body or --body-file
`);
        process.exit(1);
      }
      const viaDaemon = await tryDaemon(flags.root, "POST", "/api/handoff", {
        session,
        body,
        next: flags.next
      });
      if (viaDaemon) {
        process.stdout.write(`${green5("\u2713")} handoff written \u2192 ${dim4(".state/handoff.md")}
`);
      } else {
        handoffSet({ root: flags.root, session, body, next: flags.next });
      }
    } catch (err) {
      process.stderr.write(`${red3("Error:")} ${err.message}
`);
      process.exit(1);
    }
  }
);
registerReviewCommands(cli);
cli.parse();
//# sourceMappingURL=cli.js.map