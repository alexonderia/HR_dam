import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { probeEvaluator } from "@hr/processing";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const ready = { operation: "evaluate", available: true, alive: true, model_ready: true,
  broker: { guest: true, authorized: true }, busy: false };

test("model readiness, not HTTP success alone, controls application availability", async () => {
  for (const body of [{ ok: true }, { ...ready, model_ready: false }, { ...ready, alive: false },
    { ...ready, operation: "prepare" }, { ...ready, broker: { guest: true, authorized: false } }, null]) {
    globalThis.fetch = async () => Response.json(body);
    assert.equal((await probeEvaluator("http://fixture/ready")).available, false);
  }
});

test("busy healthy model stays available; failure and recovery change the status", async () => {
  globalThis.fetch = async () => Response.json({ ...ready, busy: true });
  const busy = await probeEvaluator("http://fixture/ready");
  assert.equal(busy.available, true);
  assert.equal(busy.busy, true);
  globalThis.fetch = async () => { throw new TypeError("Connection refused"); };
  assert.equal((await probeEvaluator("http://fixture/ready")).available, false);
  globalThis.fetch = async () => Response.json(ready);
  assert.equal((await probeEvaluator("http://fixture/ready")).available, true);
  globalThis.fetch = async () => Response.json(ready, { status: 503 });
  assert.equal((await probeEvaluator("http://fixture/ready")).available, false);
});
