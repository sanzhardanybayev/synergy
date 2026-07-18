/**
 * Filenames for the feedback-wait control channel: files dropped into
 * `<feedbackDir>/<session>/` alongside `.md` comment files. Shared by
 * `@synergy/cli`'s `feedback-wait` (the waiter) and `@synergy/preview`'s
 * `review-done`/`feedback-stream` server routes (the writers), so both sides
 * must agree on these names.
 */

/**
 * Control file the preview server writes when the user clicks "Done
 * reviewing". Its appearance ends an active `synergy feedback wait`.
 */
export const REVIEW_DONE_FILE = '.review-done';

/**
 * Presence marker maintained while a `synergy feedback wait` is active
 * (30s heartbeat touch, removed on exit). The preview's feedback SSE stream
 * stats this file (mtime freshness) to show "agent listening" in the browser.
 */
export const LISTENING_FILE = '.listening';
