import { createHash } from 'node:crypto';

/** Returns a stable SHA-256 digest for persisted review identities. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
