function pause(signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, 1000);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

// Retry only safe reads, once, under one shared deadline. Uploads and changes
// must never be duplicated after an ambiguous network failure.
export async function fetchWithReadRetry(url: string, options: RequestInit = {}): Promise<Response> {
  const read = ["GET", "HEAD"].includes((options.method || "GET").toUpperCase());
  const signal = options.signal || (read ? AbortSignal.timeout(15000) : undefined);
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try { response = await fetch(url, { ...options, signal }); }
    catch (error) {
      if (!read || attempt || signal?.aborted || !(error instanceof TypeError)) throw error;
      await pause(signal!);
      continue;
    }
    if (!read || attempt || ![502, 503, 504].includes(response.status)) return response;
    await response.body?.cancel().catch(() => {});
    await pause(signal!);
  }
}
