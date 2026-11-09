import { app } from "./app.js";
import { config } from "./config.js";
import { pool, closeBroker } from "@hr/data-access";
import { startAuthorizedProcessing } from "./processing-service.js";
import { moscowTimestamp } from "@hr/contracts";
const server = app.listen(config.port, "0.0.0.0", () => console.log(`${moscowTimestamp()} HR DAM http://localhost:${config.port}`));
const stop = startAuthorizedProcessing();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (stopping) return; stopping = true;
  server.close(() => { void stop().then(closeBroker).then(() => pool.end()).then(() => process.exit(0)); });
});
