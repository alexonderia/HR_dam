import { analysisConfig } from "@hr/data-access";

function integerSetting(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

export const config = {
  ...analysisConfig,
  healthPort: Number(process.env.WORKER_HEALTH_PORT || 3003),
  maxRetries: integerSetting("ANALYSIS_MAX_RETRIES", 2, 0, 5),
  retryDelayMs: integerSetting("ANALYSIS_RETRY_DELAY_MS", 15000, 1, 60000),
};
