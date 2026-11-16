import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { singleFlight, startPolling } from "../apps/frontend/src/lib/polling.js";

test("slow status reads never accumulate overlapping interval requests", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, release = () => {};
  const stop = startPolling(async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); }, { intervalMs: 10, timeoutMs: 10000 });
  t.after(stop);
  t.mock.timers.tick(500);
  assert.equal(calls, 1);
  release(); await setImmediate();
  t.mock.timers.tick(9); assert.equal(calls, 1);
  t.mock.timers.tick(1); assert.equal(calls, 2);
});

test("failures back off to a limit, and a successful read restores the normal interval", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, errors = 0;
  const stop = startPolling(async () => { if (++calls <= 3) throw new Error("API unavailable"); }, {
    intervalMs: 10, maxDelayMs: 40, onError: () => errors++,
  });
  t.after(stop);
  await setImmediate();
  for (const delay of [20, 40, 40]) { t.mock.timers.tick(delay - 1); await setImmediate(); const before = calls; t.mock.timers.tick(1); await setImmediate(); assert.equal(calls, before + 1); }
  assert.equal(calls, 4); assert.equal(errors, 3);
  t.mock.timers.tick(9); assert.equal(calls, 4);
  t.mock.timers.tick(1); await setImmediate(); assert.equal(calls, 5);
});

test("timed out reads are aborted, while disposing a component prevents retries and stale errors", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, errors = 0;
  const signals: AbortSignal[] = [];
  const stop = startPolling(signal => {
    calls++; signals.push(signal);
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, { intervalMs: 5, timeoutMs: 20, onError: () => errors++ });
  t.mock.timers.tick(20); await setImmediate();
  assert.equal(signals[0].aborted, true); assert.equal(errors, 1);
  t.mock.timers.tick(10); assert.equal(calls, 2);
  stop(); await setImmediate();
  assert.equal(signals[1].aborted, true);
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(calls, 2); assert.equal(errors, 1);
});

test("a hidden page does not keep polling and resumes when visible", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = false, calls = 0;
  const stop = startPolling(async () => { calls++; }, { intervalMs: 10, enabled: () => visible });
  t.after(stop);
  t.mock.timers.tick(100); assert.equal(calls, 0);
  visible = true;
  t.mock.timers.tick(10); await setImmediate(); assert.equal(calls, 1);
});

test("manual refresh and polling share one pending overview request and can refresh again after completion", async () => {
  let calls = 0, release = () => {};
  const read = singleFlight(async () => {
    calls++;
    if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
    return calls;
  });
  const requests = Array.from({ length: 20 }, () => read());
  assert.ok(requests.every(request => request === requests[0]));
  await setImmediate(); assert.equal(calls, 1);
  release(); assert.deepEqual(await Promise.all(requests), Array(20).fill(1));
  assert.equal(await read(), 2);
});
