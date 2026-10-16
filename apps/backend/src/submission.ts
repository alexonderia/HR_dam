import { acceptResumes } from "./imports.js";

export function submitCandidate(body: Record<string, unknown>, file: Express.Multer.File | undefined) {
  return acceptResumes(file, false, body);
}
