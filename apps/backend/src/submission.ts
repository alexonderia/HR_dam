import { acceptResumes } from "./imports.js";
import type { IncomingFile } from "@hr/processing";

export function submitCandidate(body: Record<string, unknown>, file: IncomingFile | undefined) {
  return acceptResumes(file, false, body);
}
