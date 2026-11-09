export function booleanSetting(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}
export const brokerEnabled = booleanSetting("RABBITMQ_ENABLED", false);
export const analyzerAdapter = process.env.ANALYZER_ADAPTER ||
  (brokerEnabled && process.env.RANK_BRIDGE_ENABLED === "false" ? "amqp" : "http");
if (analyzerAdapter !== "http" && analyzerAdapter !== "amqp") throw new Error("ANALYZER_ADAPTER must be http or amqp");
export const rankBridgeEnabled = booleanSetting("RANK_BRIDGE_ENABLED", analyzerAdapter === "http");
if (analyzerAdapter === "amqp" && (!brokerEnabled || rankBridgeEnabled))
  throw new Error("AMQP analyzer requires RABBITMQ_ENABLED=true and RANK_BRIDGE_ENABLED=false; native and bridge cannot share a queue");
if (analyzerAdapter === "http" && !rankBridgeEnabled)
  throw new Error("HTTP analyzer requires RANK_BRIDGE_ENABLED=true");
export const processingMode = brokerEnabled ? "broker" as const : "direct" as const;
