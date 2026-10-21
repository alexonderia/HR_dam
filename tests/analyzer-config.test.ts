import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test("processing config rejects native plus bridge and accepts exactly one adapter", () => {
  const module = pathToFileURL(resolve("packages/data-access/dist/processing-mode.js")).href;
  const check = (adapter: string, broker: string, bridge: string) => spawnSync(process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(module)})`], {
      env: { ...process.env, ANALYZER_ADAPTER: adapter, RABBITMQ_ENABLED: broker, RANK_BRIDGE_ENABLED: bridge }, encoding: "utf8",
    });
  for (const [adapter, broker, bridge] of [["amqp", "true", "true"], ["amqp", "false", "false"],
    ["http", "true", "false"], ["both", "true", "true"]]) {
    const result = check(adapter, broker, bridge);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /ANALYZER_ADAPTER|requires/);
  }
  for (const [adapter, broker, bridge] of [["http", "false", "true"], ["http", "true", "true"], ["amqp", "true", "false"]])
    assert.equal(check(adapter, broker, bridge).status, 0);
});
