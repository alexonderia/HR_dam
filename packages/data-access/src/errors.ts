// Handle transient infrastructure failures separately from application errors.
const infrastructureCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
  "53300", "57P01", "57P02", "57P03",
]);
const infrastructureMessages = new Set([
  "Connection terminated", "Connection terminated unexpectedly", "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect", "Connection closed", "Channel closed", "channel closed", "Heartbeat timeout",
]);
export function isInfrastructureError(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let cause = error; cause && typeof cause === "object" && !seen.has(cause);) {
    seen.add(cause);
    const value = cause as { code?: unknown; name?: string; message?: string; $metadata?: { httpStatusCode?: number }; cause?: unknown };
    if (typeof value.code === "string" && (infrastructureCodes.has(value.code) || /^08[A-Z0-9]{3}$/.test(value.code))) return true;
    if (value.code === 320 || value.code === 541 || infrastructureMessages.has(value.message || "")) return true;
    if (["TimeoutError", "NetworkingError", "SlowDown", "ServiceUnavailable"].includes(value.name || "")) return true;
    const status = value.$metadata?.httpStatusCode;
    if (status === 429 || (status != null && status >= 500 && status <= 599)) return true;
    cause = value.cause;
  }
  return false;
}
