/**
 * Tiny wrapper over the Clipboard API so tests can swap it via vi.mock.
 *
 * Returns true on success. Returns false if the browser does not expose
 * the Clipboard API or the write was rejected (permission denied, etc.).
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== 'function'
    ) {
      return false;
    }
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
