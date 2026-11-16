// Schedule the next read only after the previous one settles. A slow API must
// never accumulate a queue of interval callbacks or outlive its component.
export function startPolling(read: (signal: AbortSignal) => Promise<void>, options: {
  intervalMs: number;
  timeoutMs?: number;
  maxDelayMs?: number;
  enabled?: () => boolean;
  onError?: (error: unknown) => void;
}) {
  let stopped = false, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  const run = async () => {
    if (stopped) return;
    if (options.enabled?.() !== false) {
      request = new AbortController();
      timeout = setTimeout(() => request?.abort(new DOMException("Время ожидания истекло", "TimeoutError")), options.timeoutMs ?? 15000);
      try { await read(request.signal); failures = 0; }
      catch (error) { failures++; if (!stopped) options.onError?.(error); }
      finally { clearTimeout(timeout); request = undefined; }
    }
    if (!stopped) timer = setTimeout(() => void run(), Math.min(options.maxDelayMs ?? 30000, options.intervalMs * 2 ** Math.min(failures, 10)));
  };
  void run();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(timeout); request?.abort(); };
}

export function singleFlight<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) {
  let pending: Promise<Result> | undefined;
  return (...args: Args): Promise<Result> => {
    if (!pending) pending = Promise.resolve().then(() => operation(...args)).finally(() => { pending = undefined; });
    return pending;
  };
}
