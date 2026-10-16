import { resolve, join } from "node:path";
export const spoolRoot = resolve(process.env.RESUME_SPOOL_DIR || ".qa/resume-spool");
export function stagedFilePath(fileId: string) {
  if (!/^[a-f0-9-]{36}$/i.test(fileId)) throw new Error("Invalid staged file ID");
  return join(spoolRoot, fileId + ".bin");
}
