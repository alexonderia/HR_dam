import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Guest } from "../pages/Guest";
import { Button, Framework, Modal, ErrorMessage } from "./ui";
import { sessionApi } from "../lib/session-api";

interface Session { mode: "guest" | "authorized"; user?: { id: string; name: string } }
export function SessionGate({ children }: { children: (logout: () => void) => ReactNode }) {
  const [session, setSession] = useState<Session>(), [error, setError] = useState(""), [loginOpen, setLoginOpen] = useState(false);
  const [login, setLogin] = useState(""), [password, setPassword] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/session", { cache: "no-store" });
      const result = await response.json();
      if (response.status === 401) { setSession({ mode: "guest" }); return; }
      if (!response.ok) throw new Error("Не удалось проверить сессию.");
      setSession(result); setError("");
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => {
    void load();
    const expired = () => { setSession(undefined); void load(); };
    window.addEventListener("hr:session-expired", expired); return () => window.removeEventListener("hr:session-expired", expired);
  }, [load]);
  useEffect(() => {
    if (session?.mode !== "authorized") return;
    const timer = setInterval(() => { void sessionApi<Session>("/auth/refresh", { method: "POST" }).then(setSession).catch(() => {}); }, 300000);
    return () => clearInterval(timer);
  }, [session?.mode]);
  const logout = async () => {
    try { await sessionApi("/auth/logout", { method: "POST" }); setSession(undefined); await load(); }
    catch (e) { setError((e as Error).message); }
  };
  if (!session) return <Framework className="guest-app"><main className="guest-page"><p role="status">Проверка сессии…</p><ErrorMessage message={error} />{error && <Button onClick={() => void load()}>Повторить</Button>}</main></Framework>;
  return <>{session.mode === "authorized" ? children(() => void logout()) : <Guest onLogin={() => { setError(""); setLoginOpen(true); }} />}
    {error && session.mode === "authorized" && <div role="alert" className="af-alert af-alert--danger">{error}</div>}
    {loginOpen && <Modal title="Вход для сотрудников" className="login-dialog" onClose={() => { setLoginOpen(false); setPassword(""); }}><form className="login-form" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError("");
      try { await sessionApi("/auth/login", { method: "POST", body: JSON.stringify({ login, password }) }); setPassword(""); setLoginOpen(false); setSession(undefined); await load(); }
      catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}><div className="login-fields"><label className="af-field"><span className="af-label">Логин</span><input className="af-input af-input--lg" name="username" autoComplete="username" required disabled={busy} value={login} onChange={e => setLogin(e.target.value)} /></label>
      <label className="af-field"><span className="af-label">Пароль</span><input className="af-input af-input--lg" name="password" type="password" autoComplete="current-password" required disabled={busy} value={password} onChange={e => setPassword(e.target.value)} /></label></div>
      <ErrorMessage message={error} /><div className="af-dialog__actions"><Button className="af-btn--lg" type="submit" disabled={busy} aria-busy={busy}>{busy ? "Вход…" : "Войти"}</Button></div></form></Modal>}
  </>;
}
