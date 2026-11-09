import { keyFromEnv, cookieSettings } from "@hr/security";
import { createAuthCheck } from "./app.js";
createAuthCheck(keyFromEnv("AUTH_PUBLIC_KEY"), cookieSettings().secure).listen(Number(process.env.PORT || 3004), "0.0.0.0");
