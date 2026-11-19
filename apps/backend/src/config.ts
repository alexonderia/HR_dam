import { config as dataConfig } from "@hr/data-access";
export const config = {
  port: Number(process.env.PORT || 3001),
  bucket: dataConfig.bucket,
};
