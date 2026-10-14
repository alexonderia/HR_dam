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
import { Button, Framework } from "./components/ui";
import { Distribution } from "./pages/Distribution";
import { Submission } from "./pages/Submission";
import { Processing } from "./pages/Processing";
import { Requirements } from "./pages/Requirements";
import { Blacklist } from "./pages/Blacklist";

const navigation = [
  { path: "/", label: "Распределение", mobileLabel: "Подбор", icon: LayoutGrid },
  { path: "/submit", label: "Приём резюме", mobileLabel: "Приём", icon: FilePlus2 },
  { path: "/processing", label: "Обработка", mobileLabel: "Обработка", icon: Workflow },
  {
    path: "/requirements",
    label: "Кластеры и профили",
    mobileLabel: "Профили",
    icon: SlidersHorizontal,
  },
  { path: "/blacklist", label: "Чёрный список", mobileLabel: "Список", icon: ShieldAlert },
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
        <nav aria-label="Разделы подбора кандидатов">
          {navigation.map(({ path, label, mobileLabel, icon: Icon }) => (
            <NavLink key={path} to={path} end={path === "/"} aria-label={label} title={label}>
              <Icon size={19} />
              <span className="nav-full">{label}</span>
              <span className="nav-short" aria-hidden="true">{mobileLabel}</span>
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
              className="af-btn af-btn--clear icon-button"
              aria-label="Обновить данные"
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} className={loading ? "spin" : ""} />
            </button>
            <span className="avatar compact">HR</span>
          </div>
        </header>
        <main>
          {!analysis.available && <div className="af-alert af-alert--warning notice" role="status">{analysis.message}</div>}
          {error && (
            <div className="af-alert af-alert--danger notice" role="alert">
              <span>Не удалось подключиться к API. {error}</span>
              <Button secondary onClick={() => void refresh()}>Повторить</Button>
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
                <div className="af-empty empty">
                  <h1 className="af-heading">Страница не найдена</h1>
                  <NavLink className="af-link" to="/">К распределению</NavLink>
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
