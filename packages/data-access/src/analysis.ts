import type { AnalysisStatus } from "@hr/contracts";

export const analysisConfig = {
  rankUrl: process.env.RESUME_ANALYZER_URL || "http://127.0.0.1:8000/rank",
  readyUrl: process.env.RESUME_ANALYZER_READY_URL || new URL("ready", (process.env.RESUME_ANALYZER_URL || "http://127.0.0.1:8000/rank")).href,
  timeoutMs: Number(process.env.RESUME_ANALYZER_TIMEOUT_MS || 900000),
};

export const analysisUnavailable: AnalysisStatus = {
  available: false,
  message: "Анализ резюме временно недоступен. Резюме можно сохранить — оно будет ждать обработки. Остальные функции доступны.",
};

// Availability is separate from API health and data loading. Never throw here.
export async function probeAnalysis(
  url = analysisConfig.readyUrl,
  timeoutMs = 4000,
): Promise<AnalysisStatus> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json() as { available?: boolean };
    return response.ok && body.available === true
      ? { available: true, message: "Анализ резюме доступен." }
      : analysisUnavailable;
  } catch {
    return analysisUnavailable;
  }
}

let cached: AnalysisStatus = analysisUnavailable;
let expires = 0;
let pending: Promise<AnalysisStatus> | undefined;
export async function getAnalysisStatus(force = false): Promise<AnalysisStatus> {
  if (!force && Date.now() < expires) return cached;
  pending ??= probeAnalysis().then(status => {
    cached = status;
    expires = Date.now() + 5000;
    return status;
  }).finally(() => { pending = undefined; });
  return pending;
}
