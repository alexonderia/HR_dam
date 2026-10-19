import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import {
  UsersRound,
  FileUp,
  ScanText,
  Layers3,
  UserRoundX,
  ChevronRight,
  RefreshCw,
  BookOpenText,
  MoreHorizontal,
} from "lucide-react";
import { DataProvider, useData } from "./lib/store";
import { Button, Framework, Modal } from "./components/ui";
import { Distribution } from "./pages/Distribution";
import { Submission } from "./pages/Submission";
import { Processing } from "./pages/Processing";
import { Requirements } from "./pages/Requirements";
import { Blacklist } from "./pages/Blacklist";
import { Help } from "./pages/Help";
import { RequirementUpdatesNotice } from "./components/RequirementUpdatesNotice";
import { formatMoscowTime } from "@hr/contracts";

const navigation = [
  { path: "/", label: "Кандидаты", title: "Распределение кандидатов", mobileLabel: "Подбор", icon: UsersRound, secondary: false },
  { path: "/submit", label: "Приём резюме", title: "Приём резюме", mobileLabel: "Приём", icon: FileUp, secondary: false },
  { path: "/processing", label: "Обработка", title: "Обработка", mobileLabel: "Оценка", icon: ScanText, secondary: false },
  {
    path: "/requirements",
    label: "Профили",
    title: "Кластеры и профили",
    mobileLabel: "Профили",
    icon: Layers3,
    secondary: false,
  },
  { path: "/blacklist", label: "Чёрный список", title: "Чёрный список", mobileLabel: "Список", icon: UserRoundX, secondary: true },
  { path: "/help", label: "Памятка", title: "Памятка пользователя", mobileLabel: "Памятка", icon: BookOpenText, secondary: true },
];
function Navigation({ pending }: { pending: number }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();
  const secondaryActive = navigation.some(item => item.secondary && item.path === pathname);
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 720px)");
    const closeOnDesktop = () => { if (!mobile.matches) setMoreOpen(false); };
    mobile.addEventListener("change", closeOnDesktop);
    return () => mobile.removeEventListener("change", closeOnDesktop);
  }, []);
  return (
    <>
      <nav aria-label="Разделы подбора кандидатов">
        {navigation.map(({ path, label, title, mobileLabel, secondary, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            end={path === "/"}
            className={`af-btn af-btn--clear nav-link${secondary ? " nav-link--secondary" : ""}${path === "/help" ? " nav-link--help" : ""}`}
            aria-label={label.toLowerCase().includes(mobileLabel.toLowerCase()) ? label : `${label}, ${mobileLabel}`}
            aria-describedby={path === "/processing" && pending > 0 ? "processing-count-description" : undefined}
            title={title}
          >
            <Icon size={20} aria-hidden="true" />
            <span className="nav-full">{label}</span>
            <span className="nav-short" aria-hidden="true">{mobileLabel}</span>
            {path === "/processing" && pending > 0 && (
              <>
                <span className="nav-count" aria-hidden="true">{pending > 99 ? "99+" : pending}</span>
                <span className="sr-only" id="processing-count-description">Резюме в очереди и на оценке: {pending}</span>
              </>
            )}
          </NavLink>
        ))}
        <button
          type="button"
          className={`af-btn af-btn--clear nav-link nav-more${secondaryActive ? " active" : ""}`}
          aria-label="Ещё"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          <MoreHorizontal size={20} aria-hidden="true" />
          <span className="nav-short">Ещё</span>
        </button>
      </nav>
      {moreOpen && (
        <Modal title="Ещё" onClose={() => setMoreOpen(false)}>
          <nav className="mobile-menu" aria-label="Дополнительные разделы">
            {navigation.filter(item => item.secondary).map(({ path, label, title, icon: Icon }) => (
              <NavLink key={path} to={path} className="af-btn af-btn--clear nav-link" aria-label={title} onClick={() => setMoreOpen(false)}>
                <Icon size={20} aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
        </Modal>
      )}
    </>
  );
}
function Shell() {
  const { candidates, clusters, analysis, error, loading, refresh, refreshedAt, resumeImports } =
      useData(),
    location = useLocation();
  const pending = resumeImports.reduce((sum, batch) => sum + batch.pending_files, 0) || candidates.filter((c) =>
    ["pending", "processing"].includes(c.scoring_status),
  ).length;
  return (
    <Framework>
      <aside className="sidebar">
        <NavLink to="/" className="brand" aria-label="Алабуга — центр подбора">
          <img
            src="/assets/brand/brand-54ddb68464f478e321f2.webp"
            alt="Алабуга"
          />
        </NavLink>
        <Navigation pending={pending} />
        <div className="sidebar-bottom">
          <div className="connection" role="status" aria-live="polite">
            <i className={error ? "offline" : loading ? "connecting" : ""} aria-hidden="true" />
            <span>
              {error
                ? "Нет связи"
                : loading
                  ? "Подключение…"
                  : "Подключено"}
            </span>
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
                ?.title || "Страница"}
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
          <RequirementUpdatesNotice />
          <Routes>
            <Route path="/" element={<Distribution />} />
            <Route path="/submit" element={<Submission />} />
            <Route path="/processing" element={<Processing />} />
            <Route path="/requirements" element={<Requirements />} />
            <Route path="/blacklist" element={<Blacklist />} />
            <Route path="/help" element={<Help />} />
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
              ? `Обновлено ${formatMoscowTime(refreshedAt)}`
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
