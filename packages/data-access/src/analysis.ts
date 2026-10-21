import type { AnalysisStatus } from "@hr/contracts";
import { analyzerAdapter } from "./processing-mode.js";

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
  expectedAdapter = analyzerAdapter,
): Promise<AnalysisStatus> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return analysisUnavailable;
    const data = body as Partial<AnalysisStatus>;
    const available = response.ok && data.available === true && data.alive !== false && data.model_ready !== false &&
      (data.adapter === undefined || data.adapter === expectedAdapter) &&
      (expectedAdapter !== "amqp" || (data.adapter === "amqp" && data.model_ready === true &&
        data.consumer_alive === true && data.broker_connected === true));
    const state: Partial<AnalysisStatus> = {};
    for (const key of ["alive", "model_ready", "busy", "consumer_alive", "broker_connected"] as const)
      if (typeof data[key] === "boolean") state[key] = data[key];
    if (data.adapter === "http" || data.adapter === "amqp") state.adapter = data.adapter;
    return { ...analysisUnavailable, ...state, available,
      message: available ? (data.busy ? "Анализатор обрабатывает резюме. Следующие задания ожидают очереди." : "Анализ резюме доступен.")
        : analysisUnavailable.message };
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
