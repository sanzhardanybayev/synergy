import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { type PreviewChildHandle, terminateOwnedPreviewChild } from './preview-process.js';

class SupervisedChild extends EventEmitter implements PreviewChildHandle {
  readonly pid = 12_345;
  readonly signals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  shouldExitOnTerm = true;
  shouldExitOnKill = true;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    const shouldExit = signal === 'SIGTERM' ? this.shouldExitOnTerm : this.shouldExitOnKill;
    if (shouldExit) {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit('exit', null, signal);
      });
    }
    return true;
  }

  disconnect(): void {}

  unref(): void {}
}

describe('owned preview child cleanup', () => {
  it('waits until SIGTERM exit is observed', async () => {
    const child = new SupervisedChild();

    await expect(
      terminateOwnedPreviewChild(child, {
        deadline: performance.now() + 100,
        termGraceMs: 50,
      }),
    ).resolves.toBe(true);

    expect(child.signals).toEqual(['SIGTERM']);
    expect(child.signalCode).toBe('SIGTERM');
  });

  it('escalates through the owned handle and observes SIGKILL exit', async () => {
    const child = new SupervisedChild();
    child.shouldExitOnTerm = false;

    await expect(
      terminateOwnedPreviewChild(child, {
        deadline: performance.now() + 100,
        termGraceMs: 10,
      }),
    ).resolves.toBe(true);

    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('returns by the cleanup deadline when even SIGKILL exit is not observed', async () => {
    const child = new SupervisedChild();
    child.shouldExitOnTerm = false;
    child.shouldExitOnKill = false;
    const startedAt = performance.now();

    await expect(
      terminateOwnedPreviewChild(child, {
        deadline: startedAt + 30,
        termGraceMs: 10,
      }),
    ).resolves.toBe(false);

    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(performance.now() - startedAt).toBeLessThan(80);
  });

  it('does not escalate when the child exits while the exit listener is registered', async () => {
    const events = new EventEmitter();
    const signals: NodeJS.Signals[] = [];
    let signalCode: NodeJS.Signals | null = null;
    const child: PreviewChildHandle = {
      pid: 12_345,
      get exitCode() {
        return null;
      },
      get signalCode() {
        return signalCode;
      },
      on(eventName, listener) {
        if (eventName === 'exit' && signalCode === null) signalCode = 'SIGTERM';
        events.on(eventName, listener);
        return child;
      },
      removeListener(eventName, listener) {
        events.removeListener(eventName, listener);
        return child;
      },
      kill(signal) {
        signals.push(signal);
        return true;
      },
      disconnect() {},
      unref() {},
    };

    await expect(
      terminateOwnedPreviewChild(child, {
        deadline: performance.now() + 30,
        termGraceMs: 10,
      }),
    ).resolves.toBe(true);

    expect(signals).toEqual(['SIGTERM']);
  });
});
