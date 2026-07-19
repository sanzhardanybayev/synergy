import { parentPort, workerData } from 'node:worker_threads';
import type { ReviewFreshnessWorkerData } from './source-capture-async.js';
import { compareReviewSourceFreshness } from './source-capture.js';

if (!parentPort) throw new Error('review freshness worker requires a parent port');

const data: ReviewFreshnessWorkerData = workerData;
try {
  parentPort.postMessage({
    ok: true,
    result: compareReviewSourceFreshness(data.snapshot, data.root),
  });
} catch {
  parentPort.postMessage({ ok: false });
}
