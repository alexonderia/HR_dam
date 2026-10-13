import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDownToLine,
  ArrowUpRight,
  ChevronDown,
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
import { fullName, type Candidate, type Cluster } from "@hr/contracts";
import {
  Button,
  CandidateStatus,
  Empty,
  PageHeading,
  Person,
  Score,
} from "../components/ui";
import { CandidateDetails } from "../components/CandidateDetails";

function clusterScore(candidate: Candidate, cluster: Cluster) {
  const values = candidate.ratings
    .filter((r) => cluster.profiles.some((p) => p.id === r.profile_id))
    .map((r) => Number(r.score));
  return values.length ? Math.max(...values) : undefined;
}
export function Distribution() {
  const { candidates, clusters, loading } = useData();
  const [search, setSearch] = useState(""),
    [status, setStatus] = useState("all"),
    [activeOnly, setActiveOnly] = useState(true),
    [expanded, setExpanded] = useState<string[]>([]),
    [selected, setSelected] = useState<string>(),
    [sort, setSort] = useState("date"),
    [page, setPage] = useState(1);
  const shownClusters = clusters.filter((c) => !activeOnly || c.is_active);
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
          <div className="stat" key={label}>
            <div className="stat-top">
              <span>{label}</span>
              <Icon size={19} />
            </div>
            <strong>{loading ? "—" : value}</strong>
            <small>{note}</small>
          </div>
        ))}
      </div>
      <div className="table-intro">
        <div>
          <h2>Матрица соответствия</h2>
          <p>Раскройте кластер, чтобы увидеть оценки по каждому профилю.</p>
        </div>
        <div className="toolbar">
          <a href="/api/export" className="af-btn af-btn--secondary">
            <ArrowDownToLine size={16} />
            Экспорт CSV
          </a>
          <Button secondary onClick={() => window.print()}>
            <Printer size={16} />
            Печать
          </Button>
        </div>
      </div>
      <section className="panel distribution-panel">
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
            className="af-input filter-select"
            aria-label="Статус кандидата"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">Все статусы</option>
            <option value="in_work">Доступны для отбора</option>
            <option value="in_process">В работе</option>
            <option value="historical">Архив</option>
            <option value="pending">В обработке</option>
            <option value="blacklist">Чёрный список</option>
          </select>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            Активные кластеры
          </label>
          <select
            className="af-input filter-select sort"
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
        <div className="table-scroll">
          <table className="matrix">
            <thead>
              <tr>
                <th className="candidate-column">
                  Кандидат <span>{filtered.length}</span>
                </th>
                {shownClusters.map((c) => (
                  <th key={c.id} className="cluster-column">
                    <button
                      onClick={() => toggle(c.id)}
                      className="cluster-header"
                    >
                      {expanded.includes(c.id) ? (
                        <ChevronDown size={15} />
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
              {expanded.length > 0 && (
                <tr className="profile-head">
                  <th />
                  <>
                    {shownClusters.map((c) => (
                      <th key={c.id}>
                        {expanded.includes(c.id) ? (
                          <div className="profile-cells">
                            {c.profiles.map((p) => (
                              <span key={p.id}>
                                {p.position_name}
                                {!p.is_active && <small>Неактивен</small>}
                              </span>
                            ))}
                          </div>
                        ) : (
                          "Максимальный рейтинг"
                        )}
                      </th>
                    ))}
                  </>
                  <th />
                  <th className="no-print" />
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map((candidate) => (
                <tr key={candidate.id}>
                  <td>
                    <button
                      className="person-button"
                      onClick={() => setSelected(candidate.id)}
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
                  {shownClusters.map((cluster) => (
                    <td key={cluster.id}>
                      {expanded.includes(cluster.id) ? (
                        <div className="profile-cells">
                          {cluster.profiles.map((p) => (
                            <button
                              key={p.id}
                              className="score-button"
                              aria-label={`${p.position_name}: детали рейтинга`}
                              onClick={() => setSelected(candidate.id)}
                            >
                              <Score
                                value={
                                  candidate.ratings.find(
                                    (r) => r.profile_id === p.id,
                                  )?.score
                                }
                              />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <button
                          className="score-button"
                          aria-label={`${cluster.name}: детали рейтинга`}
                          onClick={() => setSelected(candidate.id)}
                        >
                          <Score value={clusterScore(candidate, cluster)} />
                        </button>
                      )}
                    </td>
                  ))}
                  <td>
                    <CandidateStatus candidate={candidate} />
                  </td>
                  <td className="no-print">
                    <button
                      className="icon-button"
                      aria-label={`Карточка: ${fullName(candidate)}`}
                      onClick={() => setSelected(candidate.id)}
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
                  className="text-link"
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
              disabled={currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
              aria-label="Предыдущая страница"
            >
              ‹
            </button>
            <span>
              {currentPage} / {pageCount}
            </span>
            <button
              disabled={currentPage >= pageCount}
              onClick={() => setPage(currentPage + 1)}
              aria-label="Следующая страница"
            >
              ›
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
      <div className="helper-strip">
        <SlidersHorizontal size={20} />
        <div>
          <strong>Точность начинается с требований</strong>
          <span>
            Активные профили участвуют в новых проверках. Сохранённые оценки
            можно пересчитать.
          </span>
        </div>
        <Link to="/requirements">
          Настроить профили
          <ArrowUpRight size={16} />
        </Link>
      </div>
      <p className="muted export-note">
        CSV содержит всю базу и все профили. Печать — текущую страницу таблицы с
        выбранными фильтрами.
      </p>
      {selected && (
        <CandidateDetails
          candidateId={selected}
          onClose={() => setSelected(undefined)}
        />
      )}
    </>
  );
}
