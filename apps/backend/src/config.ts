import { config as dataConfig } from "@hr/data-access";
export const config = {
  port: Number(process.env.PORT || 3001),
  bucket: dataConfig.bucket,
  clamHost: process.env.CLAMAV_HOST || "127.0.0.1",
  clamPort: Number(process.env.CLAMAV_PORT || 3310),
  maxFileSize: 10 * 1024 * 1024,
};
