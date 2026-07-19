import type { ServerResponse } from 'node:http';

interface ReviewSseEvent {
  event: string;
  id: string;
  data: unknown;
}

export interface ReviewStreamWriterOptions {
  maxQueuedRecords: number;
  onFailure(): void;
  onOverflow(): void;
  write?: (response: ServerResponse, chunk: string) => boolean;
}

function formatEvent(frame: ReviewSseEvent): string {
  return `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/** Backpressure-aware SSE writer with coalesced state and bounded durable-record queues. */
export class ReviewStreamWriter {
  private readonly pendingState = new Map<string, ReviewSseEvent>();
  private readonly pendingRecords = new Map<string, ReviewSseEvent>();
  private blocked = false;
  private closed = false;
  private keepalivePending = false;

  constructor(
    private readonly response: ServerResponse,
    private readonly options: ReviewStreamWriterOptions,
  ) {}

  sendState(key: string, frame: ReviewSseEvent): void {
    if (this.closed) return;
    if (this.blocked) {
      this.pendingState.set(key, frame);
      return;
    }
    this.write(formatEvent(frame));
  }

  sendRecord(key: string, frame: ReviewSseEvent): void {
    if (this.closed) return;
    if (!this.blocked) {
      this.write(formatEvent(frame));
      return;
    }
    if (
      !this.pendingRecords.has(key) &&
      this.pendingRecords.size >= this.options.maxQueuedRecords
    ) {
      this.options.onOverflow();
      return;
    }
    this.pendingRecords.set(key, frame);
  }

  sendKeepalive(): void {
    if (this.closed) return;
    if (this.blocked) {
      this.keepalivePending = true;
      return;
    }
    this.write(': keepalive\n\n');
  }

  drain(): void {
    if (this.closed || !this.blocked) return;
    this.blocked = false;
    for (const [key, frame] of this.pendingState) {
      this.pendingState.delete(key);
      if (!this.write(formatEvent(frame))) return;
    }
    for (const [key, frame] of this.pendingRecords) {
      this.pendingRecords.delete(key);
      if (!this.write(formatEvent(frame))) return;
    }
    if (this.keepalivePending) {
      this.keepalivePending = false;
      this.write(': keepalive\n\n');
    }
  }

  close(): void {
    this.closed = true;
    this.pendingState.clear();
    this.pendingRecords.clear();
    this.keepalivePending = false;
  }

  private write(chunk: string): boolean {
    try {
      const accepted = (this.options.write ?? ((response, value) => response.write(value)))(
        this.response,
        chunk,
      );
      this.blocked = !accepted;
      return accepted;
    } catch {
      this.options.onFailure();
      return false;
    }
  }
}
