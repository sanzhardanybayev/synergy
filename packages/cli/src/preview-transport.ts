import type { PreviewHealth } from './preview-runtime.js';

export type PreviewHealthOutcome =
  | { kind: 'healthy'; health: PreviewHealth }
  | { kind: 'absent' }
  | { kind: 'timeout' }
  | { kind: 'http-error'; status: number }
  | { kind: 'malformed' }
  | { kind: 'transport-error'; error: unknown };

export type PreviewShutdownOutcome =
  | { kind: 'accepted' }
  | { kind: 'timeout' }
  | { kind: 'http-error'; status: number }
  | { kind: 'transport-error'; error: unknown };

export interface PreviewTransportDependencies {
  clearTimer(timer: unknown): void;
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  now(): number;
  setTimer(callback: () => void, milliseconds: number): unknown;
}

interface ResponseOutcome {
  kind: 'response';
  response: Response;
  controller: AbortController;
}

type RequestOutcome =
  | ResponseOutcome
  | { kind: 'absent' }
  | { kind: 'timeout' }
  | { kind: 'transport-error'; error: unknown };

const DEFAULT_DEPENDENCIES: PreviewTransportDependencies = {
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  fetch: (input, init) => fetch(input, init),
  now: () => performance.now(),
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65_535;
}

function parseHealth(value: unknown): PreviewHealth | null {
  if (!isRecord(value)) return null;
  const expectedKeys = ['protocolVersion', 'state', 'instanceId', 'projectId', 'pid', 'port'];
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in value)) ||
    value.protocolVersion !== 1 ||
    value.state !== 'ready' ||
    typeof value.instanceId !== 'string' ||
    value.instanceId.length === 0 ||
    typeof value.projectId !== 'string' ||
    value.projectId.length === 0 ||
    !isPositiveInteger(value.pid) ||
    !isPort(value.port)
  ) {
    return null;
  }
  return {
    protocolVersion: 1,
    state: 'ready',
    instanceId: value.instanceId,
    projectId: value.projectId,
    pid: value.pid,
    port: value.port,
  };
}

function errorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current)) return null;
    if (typeof current.code === 'string') return current.code;
    current = current.cause;
  }
  return null;
}

function requestWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  dependencies: PreviewTransportDependencies,
): Promise<RequestOutcome> {
  if (timeoutMs <= 0) return Promise.resolve({ kind: 'timeout' });
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let timer: unknown = null;
    const settle = (outcome: RequestOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      resolve(outcome);
    };
    timer = dependencies.setTimer(() => {
      controller.abort();
      settle({ kind: 'timeout' });
    }, timeoutMs);
    void dependencies
      .fetch(input, { ...init, signal: controller.signal })
      .then((response) => settle({ kind: 'response', response, controller }))
      .catch((error: unknown) => {
        if (errorCode(error) === 'ECONNREFUSED') settle({ kind: 'absent' });
        else settle({ kind: 'transport-error', error });
      });
  });
}

function readJsonWithTimeout(
  response: Response,
  controller: AbortController,
  timeoutMs: number,
  dependencies: PreviewTransportDependencies,
): Promise<{ kind: 'json'; value: unknown } | { kind: 'timeout' } | { kind: 'malformed' }> {
  if (timeoutMs <= 0) {
    abortAndCancelResponse(response, controller);
    return Promise.resolve({ kind: 'timeout' });
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: unknown = null;
    const settle = (
      outcome: { kind: 'json'; value: unknown } | { kind: 'timeout' } | { kind: 'malformed' },
    ): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) dependencies.clearTimer(timer);
      resolve(outcome);
    };
    timer = dependencies.setTimer(() => {
      abortAndCancelResponse(response, controller);
      settle({ kind: 'timeout' });
    }, timeoutMs);
    void response
      .json()
      .then((value: unknown) => settle({ kind: 'json', value }))
      .catch(() => settle({ kind: 'malformed' }));
  });
}

function abortAndCancelResponse(response: Response, controller: AbortController): void {
  controller.abort();
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => undefined);
  } catch {
    // Aborting the request remains the authoritative cancellation for a locked body.
  }
}

export async function requestPreviewHealth(
  origin: string,
  timeoutMs: number,
  dependencyOverrides: Partial<PreviewTransportDependencies> = {},
): Promise<PreviewHealthOutcome> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const startedAt = dependencies.now();
  const outcome = await requestWithTimeout(
    `${origin}/api/runtime/health`,
    { method: 'GET' },
    timeoutMs,
    dependencies,
  );
  if (outcome.kind !== 'response') return outcome;
  if (!outcome.response.ok) {
    abortAndCancelResponse(outcome.response, outcome.controller);
    return { kind: 'http-error', status: outcome.response.status };
  }
  const body = await readJsonWithTimeout(
    outcome.response,
    outcome.controller,
    timeoutMs - (dependencies.now() - startedAt),
    dependencies,
  );
  if (body.kind !== 'json') return body;
  const health = parseHealth(body.value);
  return health === null ? { kind: 'malformed' } : { kind: 'healthy', health };
}

export async function requestPreviewShutdown(
  origin: string,
  instanceId: string,
  controlToken: string,
  timeoutMs: number,
  dependencyOverrides: Partial<PreviewTransportDependencies> = {},
): Promise<PreviewShutdownOutcome> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const outcome = await requestWithTimeout(
    `${origin}/api/runtime/shutdown`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ instanceId }),
    },
    timeoutMs,
    dependencies,
  );
  if (outcome.kind === 'response') {
    abortAndCancelResponse(outcome.response, outcome.controller);
    return outcome.response.ok
      ? { kind: 'accepted' }
      : { kind: 'http-error', status: outcome.response.status };
  }
  if (outcome.kind === 'absent') {
    return { kind: 'transport-error', error: new Error('Preview disappeared before shutdown') };
  }
  return outcome;
}
