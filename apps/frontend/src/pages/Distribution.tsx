import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDownToLine,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  Printer,
  Search,
  ShieldAlert,
  UsersRound,
  CheckCheck,
  Layers3,
  Clock3,
  SlidersHorizontal,
} from "lucide-react";
import { useData } from "../lib/store";
import { fullName, clusterScore, matrixColumns } from "@hr/contracts";
import {
  Button,
  CandidateStatus,
  Empty,
  PageHeading,
  Person,
  Score,
} from "../components/ui";
import { CandidateDetails } from "../components/CandidateDetails";
import { ExportDialog } from "../components/ExportDialog";

export function Distribution() {
  const { candidates, clusters, loading } = useData();
  const [search, setSearch] = useState(""),
    [status, setStatus] = useState("all"),
    [activeOnly, setActiveOnly] = useState(true),
    [expanded, setExpanded] = useState<string[]>([]),
    [selected, setSelected] = useState<string>(),
    [focus, setFocus] = useState<{ clusterId?: string; profileId?: string }>({}),
    [exportMode, setExportMode] = useState<"export" | "print">(),
    [sort, setSort] = useState("date"),
    [page, setPage] = useState(1);
  const shownClusters = clusters.filter((c) => !activeOnly || c.is_active);
  const columns = matrixColumns(shownClusters, expanded);
  const openCandidate = (id: string, clusterId?: string, profileId?: string) => {
    setFocus({ clusterId, profileId }); setSelected(id);
  };
  const filtered = useMemo(
    () =>
      candidates
        .filter(
          (c) =>
            (fullName(c) + c.phone)
              .toLowerCase()
              .includes(search.toLowerCase()) &&
            (status === "all" ||
              (status === "blacklist"
                ? c.blacklisted
                : status === "pending"
                  ? ["pending", "processing"].includes(c.scoring_status)
                  : c.status === status)),
        )
        .sort((a, b) => {
          if (sort === "name")
            return fullName(a).localeCompare(fullName(b), "ru");
          if (sort !== "date")
            return (
              (clusterScore(
                b,
                clusters.find((c) => c.id === sort)!,
              ) ?? -1) -
              (clusterScore(
                a,
                clusters.find((c) => c.id === sort)!,
              ) ?? -1)
            );
          return (
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          );
        }),
    [candidates, search, status, sort, clusters],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 15)),
    currentPage = Math.min(page, pageCount),
    rows = filtered.slice((currentPage - 1) * 15, currentPage * 15);
  const stats = [
    {
      label: "Всего кандидатов",
      value: candidates.length,
      icon: UsersRound,
      note: "В единой базе резюме",
    },
    {
      label: "Резюме оценено",
      value: candidates.filter((c) => c.scoring_status === "completed").length,
      icon: CheckCheck,
      note: "Рейтинги сформированы",
    },
    {
      label: "Активных профилей",
      value: clusters
        .filter((c) => c.is_active)
        .reduce((n, c) => n + c.profiles.filter((p) => p.is_active).length, 0),
      icon: Layers3,
      note: `В ${clusters.filter((c) => c.is_active).length} кластерах компании`,
    },
    {
      label: "В обработке",
      value: candidates.filter((c) =>
        ["pending", "processing"].includes(c.scoring_status),
      ).length,
      icon: Clock3,
      note: "В очереди и на оценке",
    },
  ];
  const toggle = (id: string) =>
    setExpanded((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  return (
    <>
      <PageHeading
        title="Распределение кандидатов"
        text="От резюме — к подходящему профилю компании."
        actions={
          <Link className="af-btn" to="/submit">
            <FilePlus2 size={17} />
            Добавить кандидата
          </Link>
        }
      />
      <div className="stats-grid">
        {stats.map(({ label, value, icon: Icon, note }) => (
          <div className="af-widget stat" key={label}>
            <div className="stat-top">
              <span>{label}</span>
              <Icon size={19} />
            </div>
            <strong className="af-metric__value">{loading ? "—" : value}</strong>
            <small className="af-caption">{note}</small>
          </div>
        ))}
      </div>
      <div className="table-intro">
        <div>
          <h2 className="af-title">Матрица соответствия</h2>
          <p>Раскройте кластер, чтобы увидеть оценки по каждому профилю.</p>
        </div>
        <div className="toolbar">
          <Button secondary onClick={() => setExportMode("export")}>
            <ArrowDownToLine size={16} />
            Экспорт
          </Button>
          <Button secondary onClick={() => setExportMode("print")}>
            <Printer size={16} />
            Печать
          </Button>
        </div>
      </div>
      <section className="af-card panel distribution-panel">
        <div className="table-filters no-print">
          <div className="search">
            <Search size={17} />
            <input
              className="af-input"
              aria-label="Поиск по ФИО или телефону"
              placeholder="Поиск по ФИО или телефону"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <select
            className="af-select filter-select"
            aria-label="Статус кандидата"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">Все статусы</option>
            <option value="in_work">В работе</option>
            <option value="in_process">В процессе</option>
            <option value="historical">Архив</option>
            <option value="pending">В обработке</option>
            <option value="blacklist">Чёрный список</option>
          </select>
          <label className="af-check checkbox">
            <input
              className="af-checkbox"
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            Активные кластеры
          </label>
          <select
            className="af-select filter-select sort"
            value={sort}
            aria-label="Сортировать"
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="date">Сначала новые</option>
            <option value="name">По ФИО</option>
            {clusters.map((c) => (
              <option key={c.id} value={c.id}>
                Рейтинг: {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="af-table-scroll table-scroll matrix-scroll">
          <table className="af-table matrix" style={{ width: "100%", minWidth: 290 + columns.length * 200 + 240 }}>
            <colgroup><col style={{ width: 290 }} />{columns.map(c => <col key={c.id} style={{ width: 200 }} />)}<col style={{ width: 180 }} /><col style={{ width: 60 }} /></colgroup>
            <thead>
              <tr>
                <th className="candidate-column">
                  Кандидат <span>{filtered.length}</span>
                </th>
                {columns.map(({ cluster: c, profile }) => profile ? (
                  <th key={profile.id} className="profile-column"><span>{profile.position_name}</span>{!profile.is_active && <small>Неактивен</small>}</th>
                ) : (
                  <th key={c.id} className={`cluster-column${expanded.includes(c.id) ? " cluster-column--expanded" : ""}`}>
                    <button
                      onClick={() => toggle(c.id)}
                      className="af-table__sort cluster-header"
                      aria-expanded={expanded.includes(c.id)}
                    >
                      {expanded.includes(c.id) ? (
                        <ChevronLeft size={15} />
                      ) : (
                        <ChevronRight size={15} />
                      )}
                      <span>
                        {c.name}
                        <small>
                          {c.profiles.length} профилей
                          {!c.is_active ? " · неактивен" : ""}
                        </small>
                      </span>
                    </button>
                  </th>
                ))}
                <th>Статус</th>
                <th className="no-print">
                  <span className="sr-only">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((candidate) => (
                <tr key={candidate.id}>
                  <td>
                    <button
                      className="af-table__sort person-button"
                      onClick={() => openCandidate(candidate.id)}
                    >
                      <Person candidate={candidate} />
                    </button>
                    {candidate.blacklisted && (
                      <span className="blacklist-label">
                        <ShieldAlert size={12} />
                        Чёрный список
                      </span>
                    )}
                  </td>
                  {columns.map(({ cluster, profile, id }) => (
                    <td key={id}>
                        <button
                          className="af-btn af-btn--clear score-button"
                          aria-label={`${profile?.position_name || cluster.name}: детали рейтинга`}
                          onClick={() => openCandidate(candidate.id, cluster.id, profile?.id)}
                        >
                          <Score value={profile ? candidate.ratings.find(r => r.profile_id === profile.id)?.score : clusterScore(candidate, cluster)} />
                        </button>
                    </td>
                  ))}
                  <td>
                    <CandidateStatus candidate={candidate} />
                  </td>
                  <td className="no-print">
                    <button
                      className="af-btn af-btn--clear icon-button"
                      aria-label={`Карточка: ${fullName(candidate)}`}
                      onClick={() => openCandidate(candidate.id)}
                    >
                      <ArrowUpRight size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <Empty
            title={
              loading
                ? "Загрузка кандидатов…"
                : search || status !== "all"
                  ? "Ничего не найдено"
                  : "Первое резюме — первый шаг"
            }
            text={
              search || status !== "all"
                ? "Измените запрос или сбросьте фильтры."
                : "Добавьте требования к профилям и загрузите резюме. После обработки оценки появятся в таблице."
            }
            action={
              !search && status === "all" ? (
                <Link
                  className="af-link text-link"
                  to={clusters.length ? "/submit" : "/requirements"}
                >
                  {clusters.length
                    ? "Добавить кандидата"
                    : "Настроить требования"}
                  <ArrowUpRight size={15} />
                </Link>
              ) : (
                <Button
                  secondary
                  onClick={() => {
                    setSearch("");
                    setStatus("all");
                  }}
                >
                  Сбросить фильтры
                </Button>
              )
            }
          />
        )}
        <div className="table-footer no-print">
          <span>
            {filtered.length
              ? `${(currentPage - 1) * 15 + 1}–${Math.min(currentPage * 15, filtered.length)} из ${filtered.length} кандидатов`
              : "0 кандидатов"}
          </span>
          <div className="pagination">
            <button
              className="af-btn af-btn--ghost af-btn--sm icon-button"
              disabled={currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
              aria-label="Предыдущая страница"
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              {currentPage} / {pageCount}
            </span>
            <button
              className="af-btn af-btn--ghost af-btn--sm icon-button"
              disabled={currentPage >= pageCount}
              onClick={() => setPage(currentPage + 1)}
              aria-label="Следующая страница"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </section>
      <div className="matrix-note">
        <div className="legend">
          <span>
            <i className="high" />
            75–100 · высокое соответствие
          </span>
          <span>
            <i className="medium" />
            45–74 · частичное
          </span>
          <span>
            <i className="low" />
            0–44 · низкое
          </span>
        </div>
        <span>Рейтинг кластера = максимум по его профилям</span>
      </div>
      <div className="af-alert af-alert--info helper-strip">
        <SlidersHorizontal size={20} />
        <div>
          <strong>Точность начинается с требований</strong>
          <span>
            Активные профили участвуют в новых проверках. Сохранённые оценки
            можно пересчитать.
          </span>
        </div>
        <Link className="af-link" to="/requirements">
          Настроить профили
          <ArrowUpRight size={16} />
        </Link>
      </div>
      <p className="muted export-note">
        Экспорт и печать учитывают текущие фильтры, порядок кандидатов и раскрытые профили на всех страницах.
      </p>
      {selected && (
        <CandidateDetails
          candidateId={selected}
          focusClusterId={focus.clusterId}
          focusProfileId={focus.profileId}
          onClose={() => setSelected(undefined)}
        />
      )}
      {exportMode && <ExportDialog candidates={filtered} clusters={shownClusters} expanded={expanded} mode={exportMode} onClose={() => setExportMode(undefined)} />}
    </>
  );
}
