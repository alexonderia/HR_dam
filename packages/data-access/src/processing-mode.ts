export function booleanSetting(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}
export const brokerEnabled = booleanSetting("RABBITMQ_ENABLED", false);
// Disable the bridge only when a native consumer replaces it in broker mode.
export const rankBridgeEnabled = !brokerEnabled || booleanSetting("RANK_BRIDGE_ENABLED", true);
export const processingMode = brokerEnabled ? "broker" as const : "direct" as const;
