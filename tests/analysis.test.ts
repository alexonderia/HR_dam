import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { probeAnalysis } from "@hr/data-access";

test("analysis probe requires explicit readiness and survives model/service outages", async () => {
  let status = 200;
  let body = '{"available":true}';
  const server = createServer((_req, res) => { res.writeHead(status); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/ready`;
  try {
    assert.equal((await probeAnalysis(url)).available, true);
    status = 503;
    assert.equal((await probeAnalysis(url)).available, false);
    status = 200; body = '{"ok":true}';
    assert.equal((await probeAnalysis(url)).available, false);
    body = 'invalid JSON';
    assert.equal((await probeAnalysis(url)).available, false);
    body = '{"available":false}';
    assert.equal((await probeAnalysis(url)).available, false);
    body = '{"available":true}';
    assert.equal((await probeAnalysis(url)).available, true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  assert.equal((await probeAnalysis(url, 100)).available, false);
});

test("nonresponsive analysis status has a bounded timeout", async () => {
  const server = createServer(() => {});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const start = Date.now();
    assert.equal((await probeAnalysis(`http://127.0.0.1:${port}`, 50)).available, false);
    assert.ok(Date.now() - start < 2000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("native availability requires the model and live consumer connection, and preserves busy separately", async () => {
  let state = { available: true, adapter: "amqp", model_ready: false, consumer_alive: true, broker_connected: true, busy: false };
  const server = createServer((_req, res) => { res.writeHead(200); res.end(JSON.stringify(state)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/ready`;
  try {
    assert.equal((await probeAnalysis(url, 1000, "amqp")).available, false);
    state.model_ready = true;
    state.busy = true;
    const ready = await probeAnalysis(url, 1000, "amqp");
    assert.equal(ready.available, true); assert.equal(ready.busy, true);
    state.broker_connected = false;
    assert.equal((await probeAnalysis(url, 1000, "amqp")).available, false);
    state.broker_connected = true; state.consumer_alive = false;
    assert.equal((await probeAnalysis(url, 1000, "amqp")).available, false);
    state.consumer_alive = true;
    assert.equal((await probeAnalysis(url, 1000, "http")).available, false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
