import type { Candidate, Cluster } from "@hr/contracts";
import { fullName, scoringLabels, statusLabels } from "@hr/contracts";

export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export function exportCsv(candidates: Candidate[], clusters: Cluster[]) {
  const profiles = clusters.flatMap((c) =>
    c.profiles.map((p) => ({ ...p, clusterName: c.name })),
  );
  const rows: unknown[][] = [
    [
      "ФИО",
      "Телефон",
      "Статус",
      "Оценка",
      "Чёрный список",
      ...clusters.map((c) => c.name + " (максимум)"),
      ...profiles.map((p) => p.clusterName + " / " + p.position_name),
    ],
    ...candidates.map((c) => [
      fullName(c),
      c.phone,
      statusLabels[c.status],
      scoringLabels[c.scoring_status],
      c.blacklisted ? "Совпадение" : "",
      ...clusters.map((cluster) => {
        const values = c.ratings
          .filter((r) => cluster.profiles.some((p) => p.id === r.profile_id))
          .map((r) => Number(r.score));
        return values.length ? Math.max(...values) : "";
      }),
      ...profiles.map(
        (p) => c.ratings.find((r) => r.profile_id === p.id)?.score ?? "",
      ),
    ]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
}
export function htmlDocument(title: string, content: string, print: boolean) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:14px Arial,sans-serif;color:#000d3c;padding:32px}h1{font-size:24px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ddd;padding:10px;text-align:left}small{color:#666}pre{white-space:pre-wrap}button{padding:10px}@media print{button{display:none}@page{size:A4 landscape;margin:15mm}body{padding:0}tr{break-inside:avoid}}</style></head><body><h1>${escapeHtml(title)}</h1>${content}${print ? '<script>window.addEventListener("load",()=>window.print())</script>' : ""}</body></html>`;
}
export function reportHtml(
  candidate: Candidate,
  clusters: Cluster[],
  print: boolean,
) {
  const rows = clusters
    .flatMap((cluster) =>
      cluster.profiles.flatMap((profile) => {
        const rating = candidate.ratings.find(
          (r) => r.profile_id === profile.id,
        );
        return rating
          ? [
              `<tr><td>${escapeHtml(cluster.name)}</td><td>${escapeHtml(profile.position_name)}</td><td>${Number(rating.score).toFixed(1)} / 100</td><td>${escapeHtml(rating.explanation)}<br>Совпадения: ${escapeHtml(rating.matched_keywords?.join(", ") || "нет")}<br>Стоп-факторы: ${escapeHtml(rating.triggered_stop_factors?.join(", ") || "нет")}<br><small>${escapeHtml(new Date(rating.calculated_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }))}</small></td></tr>`,
            ]
          : [];
      }),
    )
    .join("");
  return htmlDocument(
    `Отчёт · ${fullName(candidate)}`,
    `<p>${escapeHtml(candidate.phone)} · ${escapeHtml(statusLabels[candidate.status])} · ${escapeHtml(scoringLabels[candidate.scoring_status])}</p>${candidate.blacklisted ? "<p>Внимание: совпадение с чёрным списком. Требуется ручная проверка.</p>" : ""}<p>Файл: ${escapeHtml(candidate.file_name)}. ID резюме: ${escapeHtml(candidate.resume_id)}</p><table><thead><tr><th>Кластер</th><th>Профиль</th><th>Рейтинг</th><th>Обоснование</th></tr></thead><tbody>${rows || '<tr><td colspan="4">Оценки ещё не сформированы.</td></tr>'}</tbody></table><p><small>Результат помогает сотруднику принять решение. Изменение требований не пересчитывает прошлые оценки автоматически.</small></p>`,
    print,
  );
}
