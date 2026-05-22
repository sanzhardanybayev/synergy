import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const MAX_SLUG_LEN = 40;

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN);
}

function todayIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function generateSessionName(title: string, now: Date = new Date()): string {
  const slug = slugify(title) || 'session';
  return `${todayIsoDate(now)}-${slug}`;
}

/**
 * If `sessionsDir/<name>/` exists, append a 6-char hash of the title to make
 * it unique. Otherwise return `name` unchanged.
 */
export function uniqueSessionName(
  sessionsDir: string,
  name: string,
  title: string,
): string {
  if (!existsSync(join(sessionsDir, name))) return name;
  const hash = createHash('sha1').update(`${title}-${Date.now()}`).digest('hex').slice(0, 6);
  return `${name}-${hash}`;
}
