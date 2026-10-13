import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Candidate, Cluster, BlacklistEntry } from "@hr/contracts";
import { api } from "./api";

interface Overview {
  candidates: Candidate[];
  clusters: Cluster[];
  blacklist: BlacklistEntry[];
}
interface Store extends Overview {
  loading: boolean;
  error: string;
  refreshedAt: Date | null;
  refresh: () => Promise<void>;
}
const Context = createContext<Store | null>(null);
export function DataProvider({ children }: { children: ReactNode }) {
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
  return (
    <Context.Provider value={{ ...data, loading, error, refreshedAt, refresh }}>
      {children}
    </Context.Provider>
  );
}
export function useData() {
  return useContext(Context)!;
}
