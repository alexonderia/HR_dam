import { createHash } from "node:crypto";
export { validateFile } from "@hr/processing";
export const hashFile = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
