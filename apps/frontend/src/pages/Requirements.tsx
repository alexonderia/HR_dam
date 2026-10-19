import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Layers3,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import type { Cluster, Profile } from "@hr/contracts";
import { useData } from "../lib/store";
import { mutate } from "../lib/api";
import { StopFactorTag } from "../components/StopFactorTag";
import {
  Button,
  Empty,
  ErrorMessage,
  Field,
  Modal,
  PageHeading,
} from "../components/ui";

const newCluster = { name: "", track: "", comment: "", is_active: true };
const newProfile = {
  cluster_id: "",
  position_name: "",
  education: "",
  experience: "",
  keywords: [] as string[],
  stop_factors: [] as string[],
  comment: "",
  is_active: true,
};
type ClusterDraft = typeof newCluster & { id?: string };
type ProfileDraft = typeof newProfile & { id?: string };
export function Requirements() {
  const { clusters, refresh } = useData();
  const [clusterDraft, setClusterDraft] = useState<ClusterDraft>(),
    [profileDraft, setProfileDraft] = useState<ProfileDraft>(),
    [keywords, setKeywords] = useState(""),
    [stops, setStops] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(""),
    [expanded, setExpanded] = useState<string[]>([]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const openProfile = (cluster: Cluster, profile?: Profile) => {
    setProfileDraft(
      profile
        ? {
            ...profile,
            education: profile.education || "",
            experience: profile.experience || "",
            comment: profile.comment || "",
            keywords: profile.keywords || [],
            stop_factors: profile.stop_factors || [],
          }
        : { ...newProfile, cluster_id: cluster.id },
    );
    setKeywords(profile?.keywords?.join("\n") || "");
    setStops(profile?.stop_factors?.join("\n") || "");
    setError("");
  };
  const split = (value: string) => [
    ...new Set(
      value
        .split(/[\n;,]/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
  const filtered = [...clusters].sort((a, b) => Number(b.is_active) - Number(a.is_active)).filter((c) =>
    (c.name + c.profiles.map((p) => p.position_name).join(" "))
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeading
        title="Кластеры и профили"
        text="Сформулируйте требования, по которым будут оцениваться новые резюме."
        actions={
          <Button
            onClick={() => {
              setClusterDraft(newCluster);
              setError("");
            }}
          >
            <Plus size={17} />
            Добавить кластер
          </Button>
        }
      />
      <div className="af-alert af-alert--info notice">
        <SlidersHorizontal size={20} />
        <span>
          Проверяются только активные профили активных кластеров. Отключённые
          требования сохраняются, чтобы их можно было использовать снова. Для
          резюме «В работе» появится уведомление с предложением обновить оценки
          только по новым или изменённым кластерам.
        </span>
      </div>
      <div className="requirements-top">
        <div className="search">
          <Search size={17} />
          <input
            className="af-input"
            placeholder="Найти кластер или профиль"
            aria-label="Поиск требований"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="muted">
          {clusters.length} кластеров ·{" "}
          {clusters.reduce((n, c) => n + c.profiles.length, 0)} профилей
        </span>
      </div>
      <ErrorMessage message={error} />
      <div className="cluster-list">
        {filtered.map((cluster) => (
          <section className="af-card panel cluster-panel" key={cluster.id}>
            <div className="cluster-title">
              <button
                className="af-btn af-btn--clear cluster-toggle"
                aria-expanded={expanded.includes(cluster.id)}
                onClick={() =>
                  setExpanded((p) =>
                    p.includes(cluster.id)
                      ? p.filter((id) => id !== cluster.id)
                      : [...p, cluster.id],
                  )
                }
              >
                {!expanded.includes(cluster.id) ? (
                  <ChevronRight size={20} />
                ) : (
                  <ChevronDown size={20} />
                )}
                <span className="cluster-symbol">
                  <Layers3 size={20} />
                </span>
                <span>
                  <strong>{cluster.name}</strong>
                  <small>
                    {cluster.track} · {cluster.profiles.length} профилей
                  </small>
                </span>
              </button>
              <div className="toolbar">
                <label className="af-check switch-label">
                  <input
                    className="af-switch"
                    type="checkbox"
                    role="switch"
                    checked={cluster.is_active}
                    disabled={busy}
                    onChange={() =>
                      void run(() =>
                        mutate(
                          `/clusters/${cluster.id}`,
                          {
                            ...cluster,
                            comment: cluster.comment || "",
                            is_active: !cluster.is_active,
                          },
                          "PUT",
                        ),
                      )
                    }
                  />
                  <span>{cluster.is_active ? "Активен" : "Неактивен"}</span>
                </label>
                <button
                  className="af-btn af-btn--clear icon-button"
                  aria-label={`Изменить кластер ${cluster.name}`}
                  onClick={() => {
                    setClusterDraft({
                      ...cluster,
                      comment: cluster.comment || "",
                    });
                    setError("");
                  }}
                >
                  <Pencil size={16} />
                </button>
                <Button secondary onClick={() => openProfile(cluster)}>
                  <Plus size={16} />
                  Профиль
                </Button>
              </div>
            </div>
            {expanded.includes(cluster.id) && (
              <>
                {cluster.comment && (
                  <p className="cluster-comment">{cluster.comment}</p>
                )}
                <div className="af-table-scroll table-scroll">
                  <table className="af-table requirements-table">
                    <thead>
                      <tr>
                        <th>Профиль</th>
                        <th>Образование / опыт</th>
                        <th>Ключевые слова</th>
                        <th>Стоп-факторы</th>
                        <th>Активность</th>
                        <th>
                          <span className="sr-only">Действия</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...cluster.profiles].sort((a, b) => Number(b.is_active) - Number(a.is_active)).map((profile) => (
                        <tr key={profile.id}>
                          <td>
                            <strong>{profile.position_name}</strong>
                            {profile.comment && (
                              <small>{profile.comment}</small>
                            )}
                          </td>
                          <td>
                            {profile.education || "Не задано"}
                            <small>
                              {profile.experience || "Опыт не задан"}
                            </small>
                          </td>
                          <td>
                            <div className="tags">
                              {profile.keywords?.map((k) => (
                                <span key={k} className="af-badge tag">
                                  {k}
                                </span>
                              ))}
                              {!profile.keywords?.length && "—"}
                            </div>
                          </td>
                          <td>
                            <div className="tags">
                              {profile.stop_factors?.map((s) => (
                                <StopFactorTag key={s} text={s} className="badge--danger" />
                              ))}
                              {!profile.stop_factors?.length && "—"}
                            </div>
                          </td>
                          <td>
                            <label className={`af-check switch-label${!cluster.is_active ? " profile-control--muted" : ""}`}>
                              <input
                                className="af-switch"
                                type="checkbox"
                                role="switch"
                                checked={profile.is_active}
                                disabled={busy || !cluster.is_active}
                                title={!cluster.is_active ? "Сначала активируйте кластер" : undefined}
                                aria-label={`Активность профиля ${profile.position_name}`}
                                onChange={() =>
                                  void run(() =>
                                    mutate(
                                      `/profiles/${profile.id}`,
                                      {
                                        ...profile,
                                        education: profile.education || "",
                                        experience: profile.experience || "",
                                        comment: profile.comment || "",
                                        keywords: profile.keywords || [],
                                        stop_factors:
                                          profile.stop_factors || [],
                                        is_active: !profile.is_active,
                                      },
                                      "PUT",
                                    ),
                                  )
                                }
                              />
                              <span>
                                {profile.is_active ? "Активен" : "Неактивен"}
                              </span>
                            </label>
                          </td>
                          <td>
                            <button
                              className="af-btn af-btn--clear icon-button"
                              aria-label={`Изменить профиль ${profile.position_name}`}
                              onClick={() => openProfile(cluster, profile)}
                            >
                              <Pencil size={16} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!cluster.profiles.length && (
                  <Empty
                    title="Добавьте первый профиль"
                    text="Укажите должность, требования, ключевые слова и стоп-факторы."
                    action={
                      <Button secondary onClick={() => openProfile(cluster)}>
                        <Plus size={16} />
                        Добавить профиль
                      </Button>
                    }
                  />
                )}
              </>
            )}
          </section>
        ))}
        {!filtered.length && (
          <section className="af-card panel">
            <Empty
              title={
                search ? "Требования не найдены" : "Создайте структуру подбора"
              }
              text="Начните с кластера компании, затем добавьте необходимые ему профили."
              action={
                <Button
                  onClick={() => {
                    setClusterDraft(newCluster);
                    setError("");
                  }}
                >
                  <Plus size={16} />
                  Добавить кластер
                </Button>
              }
            />
          </section>
        )}
      </div>
      {clusterDraft && (
        <Modal
          title={clusterDraft.id ? "Настройки кластера" : "Новый кластер"}
          onClose={() => !busy && setClusterDraft(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await mutate(
                  clusterDraft.id
                    ? `/clusters/${clusterDraft.id}`
                    : "/clusters",
                  clusterDraft,
                  clusterDraft.id ? "PUT" : "POST",
                );
                setClusterDraft(undefined);
              });
            }}
          >
            <Field label="Название кластера *">
              <input
                className="af-input"
                required
                minLength={2}
                maxLength={255}
                placeholder="Например, ИТ-кластер"
                value={clusterDraft.name}
                onChange={(e) =>
                  setClusterDraft({ ...clusterDraft, name: e.target.value })
                }
              />
            </Field>
            <Field
              label="Направление / код *"
              hint="Используйте принятую в вашей компании систему направлений."
            >
              <input
                className="af-input"
                required
                maxLength={20}
                value={clusterDraft.track}
                placeholder="Код направления"
                onChange={(e) =>
                  setClusterDraft({ ...clusterDraft, track: e.target.value })
                }
              />
            </Field>
            <Field label="Общие требования и комментарий">
              <textarea
                className="af-textarea"
                rows={4}
                maxLength={10000}
                value={clusterDraft.comment}
                onChange={(e) =>
                  setClusterDraft({ ...clusterDraft, comment: e.target.value })
                }
              />
            </Field>
            <label className="af-check checkbox">
              <input
                className="af-checkbox"
                type="checkbox"
                checked={clusterDraft.is_active}
                onChange={(e) =>
                  setClusterDraft({
                    ...clusterDraft,
                    is_active: e.target.checked,
                  })
                }
              />
              Кластер активен
            </label>
            <ErrorMessage message={error} />
            <div className="dialog-footer">
              <Button
                secondary
                disabled={busy}
                onClick={() => setClusterDraft(undefined)}
              >
                Отмена
              </Button>
              <Button type="submit" disabled={busy}>
                Сохранить кластер
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {profileDraft && (
        <Modal
          title={profileDraft.id ? "Редактирование профиля" : "Новый профиль"}
          onClose={() => !busy && setProfileDraft(undefined)}
          wide
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await mutate(
                  profileDraft.id
                    ? `/profiles/${profileDraft.id}`
                    : "/profiles",
                  {
                    ...profileDraft,
                    keywords: split(keywords),
                    stop_factors: split(stops),
                  },
                  profileDraft.id ? "PUT" : "POST",
                );
                setProfileDraft(undefined);
              });
            }}
          >
            <div className="form-grid">
              <Field label="Кластер *">
                <select
                  className="af-select"
                  value={profileDraft.cluster_id}
                  onChange={(e) =>
                    setProfileDraft({
                      ...profileDraft,
                      cluster_id: e.target.value,
                    })
                  }
                >
                  {clusters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Название профиля / должности *">
                <input
                  className="af-input"
                  required
                  minLength={2}
                  maxLength={255}
                  value={profileDraft.position_name}
                  placeholder="Backend-разработчик"
                  onChange={(e) =>
                    setProfileDraft({
                      ...profileDraft,
                      position_name: e.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Образование">
                <textarea
                  className="af-textarea"
                  rows={3}
                  maxLength={5000}
                  value={profileDraft.education}
                  onChange={(e) =>
                    setProfileDraft({
                      ...profileDraft,
                      education: e.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Опыт работы">
                <textarea
                  className="af-textarea"
                  rows={3}
                  maxLength={5000}
                  value={profileDraft.experience}
                  onChange={(e) =>
                    setProfileDraft({
                      ...profileDraft,
                      experience: e.target.value,
                    })
                  }
                />
              </Field>
              <Field
                label="Ключевые слова"
                hint="Разделяйте запятыми, точками с запятой или переносами строк."
              >
                <textarea
                  className="af-textarea"
                  rows={5}
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  placeholder={"Python\nSQL\nREST API"}
                />
              </Field>
              <Field
                label="Стоп-факторы"
                hint="Разделяйте запятыми, точками с запятой или переносами строк."
              >
                <textarea
                  className="af-textarea"
                  rows={5}
                  value={stops}
                  onChange={(e) => setStops(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Дополнительные требования">
              <textarea
                className="af-textarea"
                rows={3}
                maxLength={10000}
                value={profileDraft.comment}
                onChange={(e) =>
                  setProfileDraft({ ...profileDraft, comment: e.target.value })
                }
              />
            </Field>
            <label className={`af-check checkbox${!clusters.find(c => c.id === profileDraft.cluster_id)?.is_active ? " profile-control--muted" : ""}`}>
              <input
                className="af-checkbox"
                type="checkbox"
                checked={profileDraft.is_active}
                disabled={busy || !clusters.find(c => c.id === profileDraft.cluster_id)?.is_active}
                title={!clusters.find(c => c.id === profileDraft.cluster_id)?.is_active ? "Сначала активируйте кластер" : undefined}
                onChange={(e) =>
                  setProfileDraft({
                    ...profileDraft,
                    is_active: e.target.checked,
                  })
                }
              />
              Профиль активен и участвует в новых проверках
            </label>
            <ErrorMessage message={error} />
            <div className="dialog-footer">
              <Button
                secondary
                disabled={busy}
                onClick={() => setProfileDraft(undefined)}
              >
                Отмена
              </Button>
              <Button type="submit" disabled={busy}>
                Сохранить профиль
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
