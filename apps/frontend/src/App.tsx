import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import {
  LayoutGrid,
  UsersRound,
  FilePlus2,
  Workflow,
  SlidersHorizontal,
  ShieldAlert,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { DataProvider, useData } from "./lib/store";
import { Framework } from "./components/ui";
import { Distribution } from "./pages/Distribution";
import { Submission } from "./pages/Submission";
import { Processing } from "./pages/Processing";
import { Requirements } from "./pages/Requirements";
import { Blacklist } from "./pages/Blacklist";

const navigation = [
  { path: "/", label: "Распределение", icon: LayoutGrid },
  { path: "/submit", label: "Приём резюме", icon: FilePlus2 },
  { path: "/processing", label: "Обработка", icon: Workflow },
  {
    path: "/requirements",
    label: "Кластеры и профили",
    icon: SlidersHorizontal,
  },
  { path: "/blacklist", label: "Чёрный список", icon: ShieldAlert },
];
function Shell() {
  const { candidates, clusters, analysis, error, loading, refresh, refreshedAt } =
      useData(),
    location = useLocation();
  const pending = candidates.filter((c) =>
    ["pending", "processing"].includes(c.scoring_status),
  ).length;
  return (
    <Framework>
      <aside className="sidebar">
        <a href="/" className="brand">
          <img
            src="/assets/brand/brand-54ddb68464f478e321f2.webp"
            alt="Алабуга"
          />
          <span>ЦЕНТР ПОДБОРА</span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">
            <UsersRound size={18} />
          </span>
          <div>
            <strong>Подбор кандидатов</strong>
            <small>Корпоративная платформа</small>
          </div>
        </div>
        <div className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav>
          {navigation.map(({ path, label, icon: Icon }) => (
            <NavLink key={path} to={path} end={path === "/"}>
              <Icon size={19} />
              <span>{label}</span>
              {path === "/processing" && pending > 0 && <b>{pending}</b>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection">
            <i className={error ? "offline" : ""} />
            <span>
              {error
                ? "Нет соединения"
                : loading
                  ? "Подключение…"
                  : "Система подключена"}
            </span>
          </div>
          <div className="sidebar-profile">
            <span className="avatar">HR</span>
            <div>
              <strong>Команда подбора</strong>
              <small>Алабуга</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            Рабочее пространство
            <ChevronRight size={14} />
            <strong>
              {navigation.find((item) => item.path === location.pathname)
                ?.label || "Страница"}
            </strong>
          </div>
          <div className="topbar-right">
            <span>
              {clusters.filter((c) => c.is_active).length} активных кластеров
            </span>
            <button
              className="icon-button"
              aria-label="Обновить данные"
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} className={loading ? "spin" : ""} />
            </button>
            <span className="avatar compact">HR</span>
          </div>
        </header>
        <main>
          {!analysis.available && <div className="notice warning" role="status">{analysis.message}</div>}
          {error && (
            <div className="notice danger" role="alert">
              Не удалось подключиться к API. {error}{" "}
              <button onClick={() => void refresh()}>Повторить</button>
            </div>
          )}
          <Routes>
            <Route path="/" element={<Distribution />} />
            <Route path="/submit" element={<Submission />} />
            <Route path="/processing" element={<Processing />} />
            <Route path="/requirements" element={<Requirements />} />
            <Route path="/blacklist" element={<Blacklist />} />
            <Route
              path="*"
              element={
                <div className="empty">
                  <h1>Страница не найдена</h1>
                  <NavLink to="/">К распределению</NavLink>
                </div>
              }
            />
          </Routes>
        </main>
        <footer>
          <span>Алабуга · Центр подбора кандидатов</span>
          <span>
            {refreshedAt
              ? `Обновлено ${refreshedAt.toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow" })}`
              : "Ожидание подключения"}{" "}
            · время МСК
          </span>
        </footer>
      </div>
    </Framework>
  );
}
export function App() {
  return (
    <DataProvider>
      <Shell />
    </DataProvider>
  );
}
