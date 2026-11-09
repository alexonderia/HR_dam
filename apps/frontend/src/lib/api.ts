export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch("/api/app" + url, { ...options, headers, cache: "no-store" });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("hr:session-expired"));
    const body = await response
      .json()
      .catch(() => ({ error: "Сервис недоступен." }));
    const fields = body.fields
      ? Object.entries(body.fields)
          .map(([key, values]) => `${key}: ${(values as string[]).join(", ")}`)
          .join("; ")
      : "";
    throw new Error(body.error + (fields ? " " + fields : ""));
  }
  return response.json();
}
export const mutate = <T>(url: string, data: unknown, method = "POST") =>
  api<T>(url, { method, body: JSON.stringify(data) });
export const fileUrl = (
  id: string,
  mode: "preview" | "download" | "print" = "preview",
) =>
  `/api/app/files/${id}?${mode === "download" ? "download=true" : mode === "print" ? "preview=true&print=true" : "preview=true"}`;
export const reportUrl = (
  id: string,
  mode: "preview" | "download" | "print" = "preview",
) => `/api/app/resumes/${id}/report?${mode}=true`;
export function openWindow(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}
