import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Resolve the actual Compose model with public dummy credentials, never local secrets.
const source = readFileSync("docker-compose.yml", "utf8");
const env = { ...process.env, ...Object.fromEntries([...source.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map(m => [m[1], "architecture-test-only"])) };
const resolve = profiles => {
  const result = spawnSync("docker", ["compose", "--env-file", ".env.example", ...profiles.flatMap(p => ["--profile", p]), "config", "--format", "json"], { env, encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, "Compose must resolve successfully");
  return JSON.parse(result.stdout);
};
const base = resolve([]), full = resolve(["*"]);
const names = Object.keys(base.services).sort();
assert.deepEqual(names, ["auth-check", "backend", "clamav", "flyway", "frontend", "guest-api", "postgres", "rabbitmq", "rabbitmq-init", "s3-init", "seaweedfs"].sort());
for (const old of ["worker", "resume-analyzer", "resume-analyzer-consumer"]) assert.ok(!full.services[old], `old processing service: ${old}`);
const networks = name => Object.keys(full.services[name].networks || {});
const shares = (a, b) => networks(a).some(n => networks(b).includes(n));
assert.equal(shares("guest-api", "backend"), false);
assert.equal(shares("guest-api", "postgres"), false);
assert.equal(shares("auth-check", "postgres"), false);
assert.equal(shares("auth-check", "seaweedfs"), false);
for (const name of ["auth-check", "guest-api", "backend", "postgres", "rabbitmq", "seaweedfs", "clamav", "resume-parser", "resume-evaluator"]) assert.ok(!full.services[name].ports?.length, `${name}: public ports`);
for (const name of ["auth-check", "guest-api", "resume-parser", "resume-evaluator"]) {
  const environment = Object.keys(full.services[name].environment || {});
  assert.ok(!environment.some(k => k.startsWith("POSTGRES") || k === "PGHOST"), `${name}: database credentials`);
}
for (const name of ["resume-parser", "resume-evaluator"]) {
  const processor = full.services[name];
  assert.ok(!Object.keys(processor.environment).some(k => /S3|PRIVATE_KEY/.test(k)));
  for (const other of ["postgres", "seaweedfs", "auth-check", "frontend"]) assert.equal(shares(name, other), false, `${name}: access to ${other}`);
  assert.ok(processor.secrets.every(s => /job-public$/.test(s.source)));
}
assert.deepEqual(Object.keys(full.services["auth-check"].environment).sort(), ["APP_ORIGIN", "AUTH_PUBLIC_KEY_FILE", "PORT", "TZ"].sort());
assert.ok(!base.services.frontend.depends_on);
assert.ok(base.services.backend.environment.PROCESSING_AMQP_URL.endsWith("/hr-authorized"));
assert.ok(base.services["guest-api"].environment.PROCESSING_AMQP_URL.endsWith("/hr-guest"));
for (const legacy of ["RESUME_ANALYZER_URL", "ANALYZER_ADAPTER", "RANK_BRIDGE_ENABLED", "RABBITMQ_ENABLED"]) assert.ok(!(legacy in base.services.backend.environment));
assert.ok(full.services.backend.healthcheck.test.at(-1).includes(":3001/health"));
console.log("PASS Compose: default and optional profiles, network isolation, public ports, processor credentials and current transport");
