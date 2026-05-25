import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Read the full request body and parse it as JSON.
 *
 * Returns the parsed value as `unknown` — callers must validate before use.
 * Rejects with an error if the body is not valid JSON or the stream errors.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${String(err)}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Serialize `body` as JSON and send it with the given HTTP status code.
 * Sets Content-Type to application/json.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
