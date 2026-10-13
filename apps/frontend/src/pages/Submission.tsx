import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  UploadCloud,
  ShieldCheck,
  LoaderCircle,
} from "lucide-react";
import {
  personSchema,
  normalizeName,
  normalizePhone,
} from "@hr/contracts";
import { api } from "../lib/api";
import { useData } from "../lib/store";
import { Button, ErrorMessage, Field, PageHeading } from "../components/ui";

export function Submission() {
  const { refresh, analysis } = useData();
  const [person, setPerson] = useState({
      last_name: "",
      first_name: "",
      middle_name: "",
      phone: "",
    }),
    [file, setFile] = useState<File>(),
    [replace, setReplace] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<{
      resume_id: string;
      warning: string | null;
    }>();
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseFile = (selected?: File) => {
    setError("");
    if (!selected) return;
    if (
      !/\.(pdf|docx)$/i.test(selected.name) ||
      selected.size > 10 * 1024 * 1024 ||
      !selected.size
    ) {
      setError("Выберите PDF или DOCX размером до 10 МБ.");
      return;
    }
    setFile(selected);
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const parsed = personSchema.safeParse(person);
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map(
            (i) =>
              `${({ last_name: "Фамилия", first_name: "Имя", middle_name: "Отчество", phone: "Телефон" } as Record<string, string>)[String(i.path[0])]}: ${i.message}`,
          )
          .join(". "),
      );
      return;
    }
    if (!file) {
      setError("Прикрепите резюме.");
      return;
    }
    const form = new FormData();
    Object.entries(parsed.data).forEach(([key, value]) =>
      form.append(key, value),
    );
    form.append("resume", file);
    form.append("allow_replace", String(replace));
    setBusy(true);
    try {
      const response = await api<{ resume_id: string; warning: string | null }>(
        "/candidates",
        { method: "POST", body: form },
      );
      setResult(response);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeading
        eyebrow="Приём кандидатов"
        title="Новое резюме"
        text="Заполните данные кандидата. Подходящие профили определятся после обработки."
      />
      <div className="submission-layout">
        <section className="panel form-panel">
          {result ? (
            <div className="success-state">
              <CheckCircle2 size={46} />
              <h2>Резюме принято</h2>
              <p>
                Файл прошёл проверку, сохранён и отправлен в очередь обработки.
              </p>
              {!analysis.available && (
                <p>Анализ начнётся автоматически, когда сервис и модель будут доступны.</p>
              )}
              {result.warning && (
                <div className="notice warning">{result.warning}</div>
              )}
              <Link
                className="af-btn"
                to={`/processing?resume=${result.resume_id}`}
              >
                Следить за обработкой
                <ArrowRight size={16} />
              </Link>
              <Button
                secondary
                onClick={() => {
                  setResult(undefined);
                  setPerson({
                    last_name: "",
                    first_name: "",
                    middle_name: "",
                    phone: "",
                  });
                  setFile(undefined);
                  setReplace(false);
                }}
              >
                Добавить ещё кандидата
              </Button>
            </div>
          ) : (
            <form onSubmit={submit}>
              <div className="section-label">
                <span>01</span>
                <div>
                  <h2>Данные кандидата</h2>
                  <p>Телефон и ФИО используются для проверки дублей.</p>
                </div>
              </div>
              <div className="form-grid">
                {(["last_name", "first_name", "middle_name"] as const).map(
                  (key) => (
                    <Field
                      key={key}
                      label={
                        {
                          last_name: "Фамилия *",
                          first_name: "Имя *",
                          middle_name: "Отчество",
                        }[key]
                      }
                    >
                      <input
                        className="af-input"
                        autoComplete={
                          {
                            last_name: "family-name",
                            first_name: "given-name",
                            middle_name: "additional-name",
                          }[key]
                        }
                        required={key !== "middle_name"}
                        maxLength={100}
                        placeholder={
                          {
                            last_name: "Иванов",
                            first_name: "Иван",
                            middle_name: "Иванович",
                          }[key]
                        }
                        value={person[key]}
                        onChange={(e) =>
                          setPerson({
                            ...person,
                            [key]: e.target.value.replace(/[^\p{L}\s'-]/gu, ""),
                          })
                        }
                        onBlur={() =>
                          setPerson((p) => ({
                            ...p,
                            [key]: normalizeName(p[key]),
                          }))
                        }
                      />
                    </Field>
                  ),
                )}
                <Field
                  label="Телефон *"
                  hint="Российский номер 8… будет приведён к +7…"
                >
                  <input
                    className="af-input"
                    type="tel"
                    autoComplete="tel"
                    placeholder="+7 (999) 123-45-67"
                    required
                    value={person.phone}
                    maxLength={25}
                    onChange={(e) =>
                      setPerson({
                        ...person,
                        phone: e.target.value.replace(/[^0-9+()\s-]/g, ""),
                      })
                    }
                    onBlur={() =>
                      setPerson((p) => ({
                        ...p,
                        phone: normalizePhone(p.phone),
                      }))
                    }
                  />
                </Field>
              </div>
              <div className="section-label second">
                <span>02</span>
                <div>
                  <h2>Файл резюме</h2>
                  <p>PDF или DOCX. Максимальный размер — 10 МБ.</p>
                </div>
              </div>
              <div
                className={`drop-zone ${file ? "selected" : ""}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  chooseFile(e.dataTransfer.files[0]);
                }}
              >
                <UploadCloud size={32} />
                <strong>{file ? file.name : "Перетащите резюме сюда"}</strong>
                <span>
                  {file
                    ? `${(file.size / 1024).toFixed(0)} КБ · готово к загрузке`
                    : "или выберите файл на устройстве"}
                </span>
                <Button secondary onClick={() => inputRef.current?.click()}>
                  {file ? "Заменить файл" : "Выбрать файл"}
                </Button>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".pdf,.docx"
                  className="sr-only"
                  aria-label="Файл резюме"
                  onChange={(e) => chooseFile(e.target.files?.[0])}
                />
              </div>
              <label className="checkbox replacement">
                <input
                  type="checkbox"
                  checked={replace}
                  onChange={(e) => setReplace(e.target.checked)}
                />
                Обновить резюме, если телефон и ФИО уже есть в базе
              </label>
              <small className="muted">
                Для кандидата в работе замена недоступна. При замене прошлые
                оценки будут очищены.
              </small>
              <ErrorMessage message={error} />
              <div className="form-footer">
                <span>
                  <ShieldCheck size={16} />
                  Файл проверяется антивирусом
                </span>
                <Button type="submit" disabled={busy}>
                  {busy ? (
                    <>
                      <LoaderCircle size={16} className="spin" />
                      Проверяем и сохраняем…
                    </>
                  ) : (
                    <>
                      Отправить резюме
                      <ArrowRight size={16} />
                    </>
                  )}
                </Button>
              </div>
            </form>
          )}
        </section>
        <aside className="submission-aside">
          <div className="brand-card">
            <img src="/assets/brand/brand-f4c76bb5b8514833c34e.svg" alt="" />
            <div className="eyebrow">АЛАБУГА · ЛЮДИ И ВОЗМОЖНОСТИ</div>
            <h2>
              Каждому таланту —<br />
              свой профиль.
            </h2>
            <p>
              Единый вход для кандидатов.
              <br />
              Прозрачный путь для команды.
            </p>
          </div>
          <div className="process-guide">
            <h3>Что произойдёт дальше</h3>
            {[
              ["Проверка данных", "Нормализация ФИО и телефона, поиск дублей."],
              [
                "Безопасное сохранение",
                "Проверка файла и загрузка в хранилище.",
              ],
              [
                "Проверка чёрного списка",
                "Предупреждение при совпадении данных.",
              ],
              ["Оценка по профилям", "Обработка по активным требованиям."],
              ["Готовый результат", "Рейтинги в таблице и отдельный отчёт."],
            ].map(([title, text], i) => (
              <div className="guide-step" key={title}>
                <span>{i + 1}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{text}</p>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}
