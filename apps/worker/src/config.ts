import { analysisConfig } from "@hr/data-access";
export const config = { ...analysisConfig, healthPort: Number(process.env.WORKER_HEALTH_PORT || 3003) };
