import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fetchWithReadRetry } from "../apps/frontend/src/lib/read-request.js";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

test("one temporary 503 retries the read and returns recovered data", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json({ ok: true });
  const pending = fetchWithReadRetry("/api/app/overview");
  await setImmediate();
  t.mock.timers.tick(999); assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await (await pending).json(), { ok: true });
  assert.equal(calls, 2);
});

test("a persistent outage is reported after two reads, rather than retried indefinitely", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}, { status: 503 }); };
  const pending = fetchWithReadRetry("/api/app/overview");
  await setImmediate(); t.mock.timers.tick(1000);
  assert.equal((await pending).status, 503);
  assert.equal(calls, 2);
});

test("uploads, mutations, and authorization errors are never automatically retried", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({}, { status: 503 }); };
    assert.equal((await fetchWithReadRetry("/api/app/candidates", { method })).status, 503);
    assert.equal(calls, 1);
  }
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}, { status: 401 }); };
  assert.equal((await fetchWithReadRetry("/api/app/overview")).status, 401);
  assert.equal(calls, 1);
});

test("aborting during the retry delay prevents another request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const controller = new AbortController();
  globalThis.fetch = async () => { calls++; return Response.json({}, { status: 503 }); };
  const pending = fetchWithReadRetry("/api/app/overview", { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await setImmediate(); controller.abort(); await rejected;
  t.mock.timers.tick(5000); assert.equal(calls, 1);
});

test("a lost connection retries GET once but never retries a submission", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  globalThis.fetch = async () => { if (++calls === 1) throw new TypeError("Network error"); return Response.json({ ok: true }); };
  const pending = fetchWithReadRetry("/api/app/overview");
  await setImmediate(); t.mock.timers.tick(1000);
  assert.equal((await pending).status, 200); assert.equal(calls, 2);
  globalThis.fetch = async () => { calls++; throw new TypeError("Network error"); };
  await assert.rejects(fetchWithReadRetry("/api/app/candidates", { method: "POST" }), /Network error/);
  assert.equal(calls, 3);
});
