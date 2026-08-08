import {
  compareReviewSourceFreshness
} from "./chunk-KWMKYFSK.js";

// src/source-capture-worker.ts
import { parentPort, workerData } from "node:worker_threads";
if (!parentPort) throw new Error("review freshness worker requires a parent port");
var data = workerData;
try {
  parentPort.postMessage({
    ok: true,
    result: compareReviewSourceFreshness(data.snapshot, data.root)
  });
} catch {
  parentPort.postMessage({ ok: false });
}
//# sourceMappingURL=source-capture-worker.js.map