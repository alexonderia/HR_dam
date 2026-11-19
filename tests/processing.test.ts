import { test } from "node:test";
import assert from "node:assert/strict";
import { queueStatus, presentResumeEvent } from "../apps/backend/src/processing.js";
import { assessmentCompletedMessage, type ResumeEvent } from "@hr/contracts";

const ready = { queuedAt: "2026-10-13T12:00:00Z", activeProfiles: 1, analysisAvailable: true,
  ahead: 0, processing: 0 };
const start = Date.parse(ready.queuedAt);

test("queue explains unavailable analysis and missing requirements", () => {
  assert.equal(queueStatus({ ...ready, analysisAvailable: false }, start + 120000).reason, "analysis_unavailable");
  assert.equal(queueStatus({ ...ready, activeProfiles: 0 }, start).reason, "no_profiles");
});

test("queue position includes active work and prolonged waits are reported after one minute", () => {
  const queued = queueStatus({ ...ready, ahead: 2, processing: 1 }, start + 120000);
  assert.equal(queued.reason, "waiting_turn");
  assert.equal(queued.position, 4);
  assert.equal(queued.waiting_seconds, 120);
  assert.equal(queued.delayed, true);
  assert.match(queued.message, /3/);
  assert.equal(queueStatus(ready, start + 59000).reason, "starting");
  assert.equal(queueStatus(ready, start + 60000).reason, "delayed");
  assert.equal(queueStatus(ready, start - 1000).waiting_seconds, 0);
});

test("historical journal exposes candidate checks without storage internals and retains original audit text", () => {
  const old: ResumeEvent = { id: "event", event_type: "uploaded", created_at: ready.queuedAt,
    message: "Файл проверен антивирусом, сохранён в S3. Совпадений с чёрным списком нет." };
  const shown = presentResumeEvent(old);
  assert.equal(shown.message, "Других резюме не найдено. Совпадений с чёрным списком нет.");
  assert.match(old.message, /S3/);
  const replaced = presentResumeEvent({ ...old, event_type: "replaced",
    message: "Файл проверен антивирусом, сохранён в S3. Совпадение с чёрным списком по телефону или ФИО. Нужна ручная проверка." });
  assert.match(replaced.message, /ранее загруженное/);
  assert.match(replaced.message, /Есть совпадение/);
  assert.doesNotMatch(replaced.message, /S3|PostgreSQL/);
});

test("journal translates internal failure and lifecycle messages into candidate-facing outcomes", () => {
  const event = (type: string, message: string) => presentResumeEvent({ id: "event", event_type: type, created_at: ready.queuedAt, message });
  assert.equal(event("status_changed", "Статус изменён на in_process").message, "Кандидат передан в работу.");
  assert.match(event("status_changed", "Статус изменён на historical").message, /архив/);
  assert.match(event("scoring_failed", "Текст не извлечён; нужен OCR").message, /доступным текстом/);
  const emptyDocument = event("scoring_failed",
    "Не удалось извлечь достаточно текста из резюме. Загрузите документ с доступным текстом.");
  assert.equal(emptyDocument.message, "Не удалось прочитать текст резюме. Загрузите документ с доступным текстом.");
  assert.doesNotMatch(event("scoring_failed", 'violates foreign key constraint "profile_ratings_profile_id_fkey"').message, /constraint|profile_ratings/);
  assert.equal(event("scored", "Сохранены оценки 12 профилей").message, "Оценка завершена. Результат доступен в карточке кандидата.");
});

test("assessment journal retains the blacklist warning recorded at evaluation time", () => {
  const warning = assessmentCompletedMessage(true);
  const event: ResumeEvent = { id: "scored", event_type: "scored", created_at: ready.queuedAt, message: warning };
  assert.match(warning, /Кандидат найден в чёрном списке/);
  assert.equal(presentResumeEvent(event).message, warning);
  assert.equal(event.message, warning);
  const clear = presentResumeEvent({ ...event, message: assessmentCompletedMessage(false) });
  assert.doesNotMatch(clear.message, /чёрном списке/);
});
