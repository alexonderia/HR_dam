const endpoint = process.env.RABBITMQ_MANAGEMENT_URL || "http://rabbitmq:15672";
const authorization = `Basic ${Buffer.from(`${process.env.RABBITMQ_ADMIN_USER}:${process.env.RABBITMQ_ADMIN_PASSWORD}`).toString("base64")}`;
let available = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch(`${endpoint}/api/overview`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const info = await response.json();
      const [major, minor] = info.rabbitmq_version.split(".").map(Number);
      if (major < 4 || (major === 4 && minor < 3)) throw new Error("RabbitMQ 4.3+ is required");
      available = true; break;
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 2000));
}
if (!available) throw new Error("RabbitMQ 4.3+ management API did not become ready");
async function put(path, data) {
  const response = await fetch(`${endpoint}/api/${path}`, { method: "PUT", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify(data), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`RabbitMQ initialization failed: ${path.split('/')[0]} HTTP ${response.status}: ${path.startsWith("policies/") ? (await response.text()).slice(0, 2000) : "request rejected"}`);
}
const users = [["hr_guest", "GUEST_AMQP_PASSWORD"], ["hr_authorized", "AUTHORIZED_AMQP_PASSWORD"], ["hr_prepare", "PREPARE_AMQP_PASSWORD"], ["hr_evaluate", "EVALUATE_AMQP_PASSWORD"]];
for (const [name, env] of users) {
  if (!process.env[env]) throw new Error(`${env} is required`);
  await put(`users/${name}`, { password: process.env[env], tags: name === "hr_authorized" ? "management" : "" });
}
for (const mode of ["guest", "authorized"]) {
  const vhost = `hr-${mode}`, v = encodeURIComponent(vhost);
  await put(`vhosts/${v}`, {});
  for (const name of ["hr.processing", "hr.processing.events", "hr.processing.dead"]) await put(`exchanges/${v}/${name}`, { type: "direct", durable: true, auto_delete: false, internal: false, arguments: {} });
  for (const kind of ["prepare", "evaluate", "events", "dead"]) {
    const name = `hr.${mode}.${kind}`;
    await put(`queues/${v}/${name}`, { durable: true, auto_delete: false, arguments: { "x-queue-type": "quorum",
      ...(kind === "dead" ? { "x-delivery-limit": -1 } : { "x-delayed-retry-type": "all", "x-delayed-retry-min": 1000, "x-delayed-retry-max": 30000 }) } });
    const keys = kind === "events" ? ["task.accepted", "prepare.completed", "prepare.failed", "evaluate.completed", "evaluate.failed"] : [kind];
    const exchange = kind === "dead" ? "hr.processing.dead" : kind === "events" ? "hr.processing.events" : "hr.processing";
    for (const key of keys) {
      const response = await fetch(`${endpoint}/api/bindings/${v}/e/${exchange}/q/${name}`, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify({ routing_key: `${mode}.${key}`, arguments: {} }) });
      if (!response.ok) throw new Error("RabbitMQ binding failed");
    }
  }
  // RabbitMQ 4.3 native retry: basic.reject increments delivery-count; basic.nack does not.
  await put(`policies/${v}/processing`, { pattern: `^hr\\.${mode}\\.(prepare|evaluate|events)$`, "apply-to": "quorum_queues", priority: 10,
    definition: { "delivery-limit": 5,
      "consumer-timeout": 1200000, "max-length-bytes": 134217728, "overflow": "reject-publish",
      "dead-letter-strategy": "at-least-once", "dead-letter-exchange": "hr.processing.dead", "dead-letter-routing-key": `${mode}.dead` } });
  if (mode === "guest") await put(`policies/${v}/guest-dead-retention`, { pattern: "^hr\\.guest\\.dead$", "apply-to": "quorum_queues", priority: 20,
    definition: { "message-ttl": 86400000, "max-length-bytes": 33554432, "overflow": "reject-publish" } });
  for (const [user, read] of [[`hr_${mode}`, `^hr\\.${mode}\\.(events|dead)$`], ["hr_prepare", `^hr\\.${mode}\\.prepare$`], ["hr_evaluate", `^hr\\.${mode}\\.evaluate$`]]) {
    await put(`permissions/${v}/${user}`, { configure: "^$", write: user === `hr_${mode}` ? "^hr\\.processing(\\.events)?$" : "^$", read });
  }
}
console.log("Processing vhosts, quorum queues, policies and permissions initialized");
