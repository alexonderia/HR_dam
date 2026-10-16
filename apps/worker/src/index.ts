import { createServer } from "node:http";
import { startQueueConsumer, queues, closeBroker, pool, ensureProcessingTransport, processingMode } from "@hr/data-access";
import { storeResume, failStorageJob } from "./storage.js";
import { config } from "./config.js";
import { startRankBridge } from "./rank-bridge.js";

let processing = false;
const stop = startQueueConsumer(queues.storage, async body => {
  processing = true;
  try { await storeResume(body); } finally { processing = false; }
}, failStorageJob);
const stopBridge = startRankBridge();
const server = createServer(async (req, res) => {
  if (req.url !== "/health" || req.method !== "GET") { res.writeHead(404); res.end(); return; }
  try {
    await ensureProcessingTransport();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ state: processing ? "processing" : "idle", current_resume_id: null, mode: processingMode }));
  } catch { res.writeHead(503); res.end(JSON.stringify({ state: "error", current_resume_id: null })); }
}).listen(config.healthPort, "0.0.0.0");
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close();
  void Promise.all([stop(), stopBridge()]).then(closeBroker).then(() => pool.end());
});
