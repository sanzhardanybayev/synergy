import type { IncomingMessage, ServerResponse } from 'node:http';
import { patchComment } from './feedback.js';
import { readJsonBody, sendJson } from './http.js';

export interface BatchItem {
  id: string;
  status: 'resolved' | 'rejected';
  resolution?: string;
  rejection_reason?: string;
}

export function applyFeedbackBatch(
  feedbackDir: string,
  items: BatchItem[],
): { results: { id: string; ok: boolean; error?: string }[] } {
  const results = items.map((item) => {
    try {
      patchComment(feedbackDir, item.id, {
        status: item.status,
        resolution: item.resolution,
        rejection_reason: item.rejection_reason,
      });
      return { id: item.id, ok: true as const };
    } catch (err) {
      return {
        id: item.id,
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
  return { results };
}

function isBatch(v: unknown): v is { items: BatchItem[] } {
  if (typeof v !== 'object' || v === null) return false;
  const items = (v as Record<string, unknown>).items;
  if (!Array.isArray(items)) return false;
  return items.every((i) => {
    if (typeof i !== 'object' || i === null) return false;
    const r = i as Record<string, unknown>;
    return typeof r.id === 'string' && (r.status === 'resolved' || r.status === 'rejected');
  });
}

export async function handleFeedbackBatch(
  req: IncomingMessage,
  res: ServerResponse,
  feedbackDir: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  if (!isBatch(body)) {
    sendJson(res, 400, {
      error: 'bad_request',
      detail: 'items ([{id,status,...}]) is required',
    });
    return;
  }
  sendJson(res, 200, applyFeedbackBatch(feedbackDir, body.items));
}
