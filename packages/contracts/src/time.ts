export const MOSCOW_TIME_ZONE = "Europe/Moscow";

type DateValue = Date | string | number;
const dateTime = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MOSCOW_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const time = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MOSCOW_TIME_ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const iso = new Intl.DateTimeFormat("en-GB", {
  timeZone: MOSCOW_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
  hourCycle: "h23", timeZoneName: "longOffset",
});

export const formatMoscowDateTime = (value: DateValue) => dateTime.format(new Date(value));
export const formatMoscowTime = (value: DateValue) => time.format(new Date(value));

export function formatAnalysisDuration(milliseconds: number | null | undefined) {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return "нет данных";
  if (milliseconds < 1000) return "менее 1 с";
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return [hours ? `${hours} ч` : "", minutes ? `${minutes} мин` : "", `${seconds % 60} с`].filter(Boolean).join(" ");
}

export function moscowTimestamp(value: DateValue = new Date()) {
  const parts = Object.fromEntries(iso.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  // PostgreSQL JSON may carry microseconds; changing the zone must preserve them.
  const fraction = typeof value === "string"
    ? value.match(/\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/)?.[1] : undefined;
  const offset = parts.timeZoneName.replace("GMT", "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${fraction || parts.fractionalSecond}${offset}`;
}

const timestampFields = new Set([
  "created_at", "updated_at", "calculated_at", "download_url_expires_at", "queuedAt", "timestamp",
]);

export function moscowJsonReplacer(key: string, value: unknown) {
  return timestampFields.has(key) && typeof value === "string" && Number.isFinite(Date.parse(value))
    ? moscowTimestamp(value) : value;
}
