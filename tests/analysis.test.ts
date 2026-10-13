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
