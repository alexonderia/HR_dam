export async function sessionApi<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, cache: "no-store", credentials: "same-origin",
    headers: options?.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json", ...options.headers } : options?.headers });
  const data = await response.json().catch(() => ({ error: "Сервис недоступен." }));
  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login") window.dispatchEvent(new Event("hr:session-expired"));
    throw new Error(data.error || "Не удалось выполнить запрос.");
  }
  return data;
}
