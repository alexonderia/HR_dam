import { app } from "./app.js";
import { config } from "./config.js";
import { pool, flushImportOutbox, closeBroker } from "@hr/data-access";
import { startResultConsumers } from "./import-results.js";
import { reconcilePendingResumes } from "./imports.js";

const server = app.listen(config.port, "0.0.0.0", () =>
  console.log(`HR DAM http://localhost:${config.port}`),
);
const stopConsumers = startResultConsumers();
let flushing = false;
let reconciled = false;
const flush = async () => {
  if (flushing) return;
  flushing = true;
  try {
    await flushImportOutbox();
    if (!reconciled) { await reconcilePendingResumes(); reconciled = true; }
  } catch { console.error("Resume outbox unavailable; retrying"); }
  finally { flushing = false; }
};
void flush();
const outboxTimer = setInterval(() => void flush(), 10000);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(outboxTimer);
    server.close(() => {
      void stopConsumers().then(closeBroker).then(() => pool.end()).then(() => process.exit(0));
    });
  });
