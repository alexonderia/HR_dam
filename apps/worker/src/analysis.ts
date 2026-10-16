import { setTimeout as delay } from "node:timers/promises";
import { Agent, fetch, FormData, type Response } from "undici";
import { validateRankResponse } from "@hr/contracts";
import type { Cluster } from "@hr/contracts";

type RankResult = ReturnType<typeof validateRankResponse>;
type FailureKind = "http" | "network" | "timeout" | "contract";

export class AnalysisError extends Error {
  constructor(message: string, readonly kind: FailureKind,
    readonly retryable = false, readonly httpStatus?: number) {
    super(message);
  }
}

export interface AnalysisEvent {
  type: "started" | "completed" | "retry" | "failed";
  clusters: number;
  profiles: number;
  attempt: number;
  duration_ms?: number;
  retry_delay_ms?: number;
  error_kind?: FailureKind;
  http_status?: number;
}

interface AnalysisOptions {
  rankUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

function networkFailure(error: unknown): AnalysisError {
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT")
    return new AnalysisError("Истекло время ожидания ответа анализатора. Повторите оценку позже.", "timeout");
  const retryable = !!code && ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT",
    "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
  return new AnalysisError("Не удалось подключиться к обработчику анализа.", "network", retryable);
}

async function rankOnce(clusters: Cluster[], requirements: string, file: Blob, filename: string,
  rankUrl: string, signal: AbortSignal, dispatcher: Agent): Promise<RankResult> {
  // Every attempt carries the same file and ALL cluster/profile requirements.
  const form = new FormData();
  form.append("file", file, filename);
  form.append("requirements", requirements);
  let response: Response;
  try {
    response = await fetch(rankUrl, { method: "POST", body: form, signal, dispatcher });
  } catch (error) {
    throw networkFailure(error);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail = body && typeof body === "object"
      ? (body as { error?: unknown; detail?: unknown }).error || (body as { detail?: unknown }).detail
      : null;
    const message = typeof detail === "string" ? detail.slice(0, 500)
      : `Обработчик вернул HTTP ${response.status}`;
    throw new AnalysisError(message, "http", [429, 500, 502, 503, 504].includes(response.status), response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    const network = networkFailure(error);
    if (network.retryable || network.kind === "timeout") throw network;
    throw new AnalysisError("Обработчик вернул некорректный JSON.", "contract");
  }
  try {
    return validateRankResponse(body, clusters);
  } catch {
    throw new AnalysisError("Обработчик вернул неполный или некорректный набор оценок.", "contract");
  }
}

export async function analyzeResume(clusters: Cluster[], file: Blob, filename: string,
  options: AnalysisOptions, onEvent: (event: AnalysisEvent) => void = () => {}): Promise<RankResult> {
  // All attempts, response bodies and delays share the original timeout and worker lease.
  const signal = AbortSignal.timeout(options.timeoutMs);
  // Undici otherwise stops waiting for response headers/body after five minutes.
  const dispatcher = new Agent({ headersTimeout: options.timeoutMs, bodyTimeout: options.timeoutMs,
    connectTimeout: options.timeoutMs });
  const requirements = JSON.stringify({ clusters });
  const context = { clusters: clusters.length, profiles: clusters.reduce((sum, c) => sum + c.profiles.length, 0) };
  try {
    for (let attempt = 1; ; attempt++) {
      const started = performance.now();
      onEvent({ type: "started", ...context, attempt });
      try {
        signal.throwIfAborted();
        const ranked = await rankOnce(clusters, requirements, file, filename, options.rankUrl, signal, dispatcher);
        onEvent({ type: "completed", ...context, attempt, duration_ms: Math.round(performance.now() - started) });
        return ranked;
      } catch (error) {
        const failure = signal.aborted
          ? new AnalysisError("Истекло время анализа. Повторите оценку позже.", "timeout")
          : error instanceof AnalysisError ? error
          : new AnalysisError("Не удалось завершить анализ.", "contract");
        const diagnostic = { ...context, attempt, duration_ms: Math.round(performance.now() - started),
          error_kind: failure.kind, http_status: failure.httpStatus };
        if (!failure.retryable || attempt > options.maxRetries || signal.aborted) {
          onEvent({ type: "failed", ...diagnostic });
          throw failure;
        }
        const retryDelay = Math.min(60000, options.retryDelayMs * 2 ** (attempt - 1));
        onEvent({ type: "retry", ...diagnostic, retry_delay_ms: retryDelay });
        try {
          await delay(retryDelay, undefined, { signal });
        } catch {
          const timeout = new AnalysisError("Истекло время анализа. Повторите оценку позже.", "timeout");
          onEvent({ type: "failed", ...context, attempt, error_kind: timeout.kind });
          throw timeout;
        }
      }
    }
  } finally {
    await dispatcher.destroy();
  }
}
