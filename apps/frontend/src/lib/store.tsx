import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Candidate, Cluster, BlacklistEntry, AnalysisStatus, ResumeImportSummary, RequirementUpdates } from "@hr/contracts";
import { api } from "./api";
import { singleFlight, startPolling } from "./polling";

interface Overview {
  candidates: Candidate[];
  clusters: Cluster[];
  blacklist: BlacklistEntry[];
  resumeImports: ResumeImportSummary[];
  resumeImportsError?: string;
  requirementUpdates?: RequirementUpdates;
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
    resumeImports: [],
  });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const load = useMemo(() => singleFlight(async (signal?: AbortSignal) => {
    try {
      const overview = await api<Overview>("/overview", { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
      if (signal?.aborted) return;
      setData(previous => ({ ...overview, resumeImports: overview.resumeImportsError ? previous.resumeImports : overview.resumeImports ?? [] }));
      setError("");
      setRefreshedAt(new Date());
    } catch (e) {
      if (!signal?.aborted) setError((e as Error).message);
      throw e;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }), []);
  const refresh = useCallback(() => load().catch(() => {}), [load]);
  useEffect(() => startPolling(load, {
    intervalMs: 3000, timeoutMs: 16000, enabled: () => !document.hidden,
  }), [load]);
  useEffect(() => {
    return startPolling(async signal => {
      const status = await api<AnalysisStatus>("/analysis/status", { signal });
      if (!signal.aborted) setAnalysis(status);
    }, { intervalMs: 5000, timeoutMs: 15000, enabled: () => !document.hidden,
      onError: () => setAnalysis({ available: false, message: "Анализ резюме временно недоступен. Резюме можно сохранить — оно будет ждать обработки. Остальные функции доступны." }),
    });
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
