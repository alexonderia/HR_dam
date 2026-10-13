import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Candidate, Cluster, BlacklistEntry, AnalysisStatus } from "@hr/contracts";
import { api } from "./api";

interface Overview {
  candidates: Candidate[];
  clusters: Cluster[];
  blacklist: BlacklistEntry[];
}
interface Store extends Overview {
  analysis: AnalysisStatus;
  loading: boolean;
  error: string;
  refreshedAt: Date | null;
  refresh: () => Promise<void>;
}
const Context = createContext<Store | null>(null);
export function DataProvider({ children }: { children: ReactNode }) {
  const [analysis, setAnalysis] = useState<AnalysisStatus>({
    available: false, message: "Проверяем доступность анализа резюме…",
  });
  const [data, setData] = useState<Overview>({
    candidates: [],
    clusters: [],
    blacklist: [],
  });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const refresh = useCallback(async () => {
    try {
      setData(await api<Overview>("/overview"));
      setError("");
      setRefreshedAt(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    let active = true;
    let running = false;
    const check = async () => {
      if (running) return;
      running = true;
      try {
        const status = await api<AnalysisStatus>("/analysis/status", { signal: AbortSignal.timeout(6000) });
        if (active) setAnalysis(status);
      } catch {
        if (active) setAnalysis({ available: false, message: "Анализ резюме временно недоступен. Резюме можно сохранить — оно будет ждать обработки. Остальные функции доступны." });
      } finally { running = false; }
    };
    void check();
    const timer = setInterval(() => { if (!document.hidden) void check(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  return (
    <Context.Provider value={{ ...data, analysis, loading, error, refreshedAt, refresh }}>
      {children}
    </Context.Provider>
  );
}
export function useData() {
  return useContext(Context)!;
}
