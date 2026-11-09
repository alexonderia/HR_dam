import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import "./generate-keys.mjs";
let content = await readFile(".env", "utf8").catch(() => "");
const present = parseEnv(content);
const defaults = {
  APP_ORIGIN: "http://localhost:3000", RABBITMQ_ADMIN_USER: "hr_admin", RABBITMQ_ADMIN_PASSWORD: randomBytes(24).toString("hex"),
  GUEST_AMQP_PASSWORD: randomBytes(24).toString("hex"), AUTHORIZED_AMQP_PASSWORD: randomBytes(24).toString("hex"),
  PREPARE_AMQP_PASSWORD: randomBytes(24).toString("hex"), EVALUATE_AMQP_PASSWORD: randomBytes(24).toString("hex"),
  GUEST_S3_ACCESS_KEY: `guest_${randomBytes(12).toString("hex")}`, GUEST_S3_SECRET_KEY: randomBytes(24).toString("hex"),
  S3_INIT_ACCESS_KEY: `init_${randomBytes(12).toString("hex")}`, S3_INIT_SECRET_KEY: randomBytes(24).toString("hex"),
  ...Object.fromEntries(["AUTH", "GUEST_JOB", "AUTHORIZED_JOB", "GUEST_COOKIE"].flatMap(name => ["PRIVATE", "PUBLIC"].map(kind => [`${name}_${kind}_KEY_FILE`, `.secrets/${name.toLowerCase().replaceAll("_", "-")}-${kind.toLowerCase()}.pem`]))),
};
for (const [name, value] of Object.entries(defaults)) if (!present[name]) { content += `\n${name}=${value}`; present[name] = value; }
await writeFile(".env", content.trimEnd() + "\n", { mode: 0o600 });
if (present.S3_BUCKET === "guest-temporary") throw new Error("S3_BUCKET must be a permanent bucket");
if (!present.S3_ACCESS_KEY || !present.S3_SECRET_KEY || !present.S3_BUCKET) throw new Error("Configure permanent S3_ACCESS_KEY, S3_SECRET_KEY and S3_BUCKET in .env first");
const identity = (name, access, secret, bucket) => ({ name, credentials: [{ accessKey: access, secretKey: secret }],
  actions: ["Read", "Write", "List", "Tagging", ...(bucket ? [] : ["Admin"])].map(action => bucket ? `${action}:${bucket}` : action) });
await writeFile(".secrets/seaweed-s3.json", JSON.stringify({ identities: [
  identity("initializer", present.S3_INIT_ACCESS_KEY, present.S3_INIT_SECRET_KEY),
  identity("authorized", present.S3_ACCESS_KEY, present.S3_SECRET_KEY, present.S3_BUCKET),
  identity("guest", present.GUEST_S3_ACCESS_KEY, present.GUEST_S3_SECRET_KEY, "guest-temporary"),
] }), { mode: 0o600 });
console.log("Environment prepared; existing settings preserved. Secrets were not printed.");
