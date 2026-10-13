import { useState } from "react";
import { Pencil, Plus, Search, ShieldAlert } from "lucide-react";
import {
  type BlacklistEntry,
  normalizeName,
  normalizePhone,
  fullName,
} from "@hr/contracts";
import { useData } from "../lib/store";
import { mutate } from "../lib/api";
import {
  Button,
  Empty,
  ErrorMessage,
  Field,
  Modal,
  PageHeading,
} from "../components/ui";

const blank = {
  last_name: "",
  first_name: "",
  middle_name: "",
  phone: "",
  company_name: "",
  is_active: true,
};
export function Blacklist() {
  const { blacklist, refresh } = useData();
  const [draft, setDraft] = useState<typeof blank & { id?: string }>(),
    [search, setSearch] = useState(""),
    [active, setActive] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
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
  const filtered = blacklist.filter(
    (p) =>
      (!active || p.is_active) &&
      (fullName(p) + p.phone + p.company_name)
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeading
        title="Чёрный список"
        text="Независимый список для проверки кандидатов перед передачей в работу."
        actions={
          <Button
            onClick={() => {
              setDraft(blank);
              setError("");
            }}
          >
            <Plus size={16} />
            Добавить запись
          </Button>
        }
      />
      <div className="notice warning">
        <ShieldAlert size={20} />
        <span>
          Совпадение по телефону или полному ФИО создаёт предупреждение. Оценка
          резюме продолжается. Данные хранятся отдельно от кандидатов, без связи
          между таблицами.
        </span>
      </div>
      <section className="panel">
        <div className="table-filters">
          <div className="search">
            <Search size={17} />
            <input
              className="af-input"
              placeholder="ФИО, телефон или компания"
              aria-label="Поиск в чёрном списке"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            Только активные
          </label>
          <span className="muted">{filtered.length} записей</span>
        </div>
        <ErrorMessage message={error} />
        <div className="table-scroll">
          <table className="requirements-table">
            <thead>
              <tr>
                <th>ФИО</th>
                <th>Телефон</th>
                <th>Компания</th>
                <th>Активность</th>
                <th>
                  <span className="sr-only">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{fullName(p)}</strong>
                  </td>
                  <td>{p.phone}</td>
                  <td>{p.company_name}</td>
                  <td>
                    <label className="switch-label">
                      <input
                        type="checkbox"
                        role="switch"
                        checked={p.is_active}
                        disabled={busy}
                        aria-label={`Активность записи ${fullName(p)}`}
                        onChange={() =>
                          void run(() =>
                            mutate(
                              `/blacklist/${p.id}`,
                              {
                                ...p,
                                middle_name: p.middle_name || "",
                                is_active: !p.is_active,
                              },
                              "PUT",
                            ),
                          )
                        }
                      />
                      <span>{p.is_active ? "Активна" : "Неактивна"}</span>
                    </label>
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`Изменить запись ${fullName(p)}`}
                      onClick={() => {
                        setDraft({ ...p, middle_name: p.middle_name || "" });
                        setError("");
                      }}
                    >
                      <Pencil size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <Empty
            title={search ? "Совпадений нет" : "Список пока пуст"}
            text="Добавляйте записи здесь или копируйте данные из карточки кандидата."
          />
        )}
      </section>
      {draft && (
        <Modal
          title={
            draft.id ? "Редактирование записи" : "Новая запись чёрного списка"
          }
          onClose={() => !busy && setDraft(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await mutate(
                  draft.id ? `/blacklist/${draft.id}` : "/blacklist",
                  draft,
                  draft.id ? "PUT" : "POST",
                );
                setDraft(undefined);
              });
            }}
          >
            <div className="form-grid">
              {(
                [
                  "last_name",
                  "first_name",
                  "middle_name",
                  "phone",
                  "company_name",
                ] as const
              ).map((key) => (
                <Field
                  key={key}
                  label={
                    {
                      last_name: "Фамилия *",
                      first_name: "Имя *",
                      middle_name: "Отчество",
                      phone: "Телефон *",
                      company_name: "Компания *",
                    }[key]
                  }
                >
                  <input
                    className="af-input"
                    required={key !== "middle_name"}
                    maxLength={
                      key === "company_name" ? 255 : key === "phone" ? 25 : 100
                    }
                    type={key === "phone" ? "tel" : "text"}
                    value={draft[key]}
                    onChange={(e) =>
                      setDraft({ ...draft, [key]: e.target.value })
                    }
                    onBlur={() =>
                      setDraft(
                        (p) =>
                          p && {
                            ...p,
                            [key]:
                              key === "phone"
                                ? normalizePhone(p[key])
                                : normalizeName(p[key]),
                          },
                      )
                    }
                  />
                </Field>
              ))}
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.is_active}
                onChange={(e) =>
                  setDraft({ ...draft, is_active: e.target.checked })
                }
              />
              Запись активна
            </label>
            <ErrorMessage message={error} />
            <div className="dialog-footer">
              <Button
                secondary
                disabled={busy}
                onClick={() => setDraft(undefined)}
              >
                Отмена
              </Button>
              <Button type="submit" disabled={busy}>
                Сохранить
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
