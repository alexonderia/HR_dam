import type { Candidate, Cluster } from "@hr/contracts";
import { fullName, scoringLabels, statusLabels, formatMoscowDateTime, formatAnalysisDuration, ratingScoreText, clusterScore, clusterScoreRange, ratingRangeText, ratingAnalysis, type ReportRating } from "@hr/contracts";

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
      ...clusters.flatMap((c) => [c.name + " (максимум)", c.name + " / Диапазон"]),
      ...profiles.flatMap((p) => [p.clusterName + " / " + p.position_name, p.clusterName + " / " + p.position_name + " / Диапазон"]),
    ],
    ...candidates.map((c) => [
      fullName(c) || "ФИО не указано",
      c.phone || "",
      statusLabels[c.status],
      scoringLabels[c.scoring_status],
      c.blacklisted ? "Совпадение" : "",
      ...clusters.flatMap((cluster) => {
        const range = clusterScoreRange(c, cluster);
        return [clusterScore(c, cluster) ?? "", range ? `${range.min}–${range.max}` : ""];
      }),
      ...profiles.flatMap(
        (p) => { const rating = c.ratings.find(r => r.profile_id === p.id); return rating ? [Number(rating.score), ratingRangeText(rating)] : ["", ""]; },
      ),
    ]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
}
export function htmlDocument(title: string, content: string, print: boolean) {
  // The small fallback keeps downloaded HTML readable without the application.
  // When opened through the application, the actual framework overrides it.
  return `<!doctype html>
<html lang="ru"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    .af{font:400 16px/1.35 var(--af-font-body,"Alabuga Sans",Arial,sans-serif);color:var(--af-text-primary,#161616)}
    .af-heading{font:800 32px/1 var(--af-font-heading,"Alabuga Heading",Arial,sans-serif);letter-spacing:-.02em;margin:0 0 24px}
    .af-eyebrow{font-size:12px;letter-spacing:.12em;color:var(--af-text-link,#0956bb);margin-bottom:16px}
    .af-caption{font-size:12px;line-height:1.35;color:var(--af-text-secondary,#6c757d)}
    .af-table-scroll{overflow:auto}
    .af-table{width:100%;border-collapse:collapse;font-size:14px;text-align:left}
    .af-table th,.af-table td{padding:10px 12px;border-bottom:1px solid var(--af-border-default,#dee2e6)}
    .af-table th{background:var(--af-color-neutral-50,#f8f9fa);color:var(--af-text-primary,#161616);font-weight:500}
    .af-table--wrap{table-layout:fixed}
    .af-table--wrap th,.af-table--wrap td{white-space:normal;overflow-wrap:anywhere;vertical-align:top}
    .af-alert{padding:12px;border-radius:8px;font-size:14px;line-height:1.4}
    .af-alert--warning{background:var(--af-feedback-warning-bg,#ffdfb5);color:var(--af-feedback-warning-text,#874700)}
  </style>
  <link rel="stylesheet" href="/alabuga/alabuga.css">
  <style>
    body{margin:0;background:var(--af-bg-canvas,#fff)}
    .report{max-width:1280px;margin:auto;padding:var(--af-space-32,32px)}
    .report p{margin:0 0 var(--af-space-16,16px)}
    .report .af-heading{overflow-wrap:anywhere}
    .report-table{min-width:720px;margin-bottom:var(--af-space-24,24px)}
    .report pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
    .report td,.report th{white-space:normal;overflow-wrap:anywhere;min-width:140px;vertical-align:top}
    .report td:first-child{min-width:240px}
    .report td p{margin:0 0 10px}
    .rating-report{margin:24px 0;padding:20px;border:1px solid #dee2e6;border-radius:8px;overflow-wrap:anywhere}
    .rating-report h3{margin:0 0 16px}.rating-report h4{margin:20px 0 12px}
    .rating-report .primary-score{font-size:20px;font-weight:600}
    .rating-report dl{display:flex;flex-wrap:wrap;gap:24px;margin:16px 0}
    .rating-report dt{color:#59636e}.rating-report dd{margin:4px 0;font-weight:600}
    .rating-report ul{padding-left:20px}.rating-report li{margin:0 0 16px;break-inside:avoid}
    .rating-report blockquote{margin:8px 0;padding-left:12px;border-left:2px solid #dee2e6;white-space:pre-wrap}
    .rating-report .criterion-category{display:block;color:#59636e;font-size:12px;margin-bottom:4px}
    .individual-report{break-before:page}
    .report-section{scroll-margin-top:20px}
    .report-section:target{outline:2px solid #0956bb}
    .report-controls{display:flex;flex-wrap:wrap;align-items:end;gap:12px;margin:24px 0;padding:16px;background:#f8f9fa}
    .report-controls label{display:grid;gap:6px}
    .report-controls select,.report-controls button{font:inherit;padding:8px 12px}
    @media(max-width:640px){.report{padding:var(--af-space-16,16px)}}
    @media print{
      @page{size:A4 landscape;margin:15mm}
      .report{max-width:none;padding:0}
      .af-table-scroll{overflow:visible}
      .report-table{min-width:0}
      .report-controls{display:none}
      .report td,.report th{min-width:0;font-size:9px}
      .report-table{table-layout:fixed;width:100%}
      .report-table th{position:static;print-color-adjust:exact;-webkit-print-color-adjust:exact}
      tr{break-inside:avoid}
    }
  </style>
</head><body class="af"><main class="report">
  <div class="af-eyebrow">Алабуга · Центр подбора</div>
  <h1 class="af-heading">${escapeHtml(title)}</h1>
  ${content}
</main>${print ? '<script>window.addEventListener("load",()=>document.fonts.ready.then(()=>window.print()))</script>' : ""}</body></html>`;
}
export function reportContent(
  candidate: Candidate,
  clusters: Cluster[],
  tablesOnly = false,
  anchorPrefix = "",
) {
  const processed = candidate.ratings.map(r => r.calculated_at).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
  const analyses: string[] = [];
  const rows = clusters
    .flatMap((cluster) =>
      cluster.profiles.flatMap((profile) => {
        const rating = candidate.ratings.find(
          (r) => r.profile_id === profile.id,
        );
        const evidence = rating ? ratingAnalysis(rating).evidence : undefined;
        if (rating && !tablesOnly) analyses.push(`<section class="rating-report"><h3>${escapeHtml(cluster.name)} / ${escapeHtml(profile.position_name)}</h3><p class="primary-score">Основная оценка: ${escapeHtml(ratingScoreText(rating))} / 100</p>${ratingAnalysisHtml(rating)}</section>`);
        return rating
          ? [
              `<tr id="profile-${escapeHtml(anchorPrefix + profile.id)}" class="report-section"><td>${profile.id === cluster.profiles.find(p => candidate.ratings.some(r => r.profile_id === p.id))?.id ? `<span id="cluster-${escapeHtml(anchorPrefix + cluster.id)}"></span>` : ""}${escapeHtml(cluster.name)}</td><td>${escapeHtml(profile.position_name)}</td><td class="primary-score">${escapeHtml(ratingScoreText(rating))} / 100</td><td>${escapeHtml(ratingRangeText(rating) || "Не указан")}</td><td>${evidence?.coverage ?? "—"}${evidence ? "%" : ""}</td></tr>`,
            ]
          : [];
      }),
    )
    .join("");
  return `${tablesOnly ? "" : `<p>${escapeHtml(candidate.phone || "Телефон не указан")} · ${escapeHtml(statusLabels[candidate.status])} · ${escapeHtml(scoringLabels[candidate.scoring_status])}</p>${candidate.blacklisted ? '<p class="af-alert af-alert--warning">Внимание: совпадение с чёрным списком. Требуется ручная проверка.</p>' : ""}<p class="af-caption">Файл: ${escapeHtml(candidate.file_name)}. Обработано: ${processed ? escapeHtml(formatMoscowDateTime(processed)) + " МСК" : "оценка ещё не завершена"}. Время анализа: ${escapeHtml(formatAnalysisDuration(candidate.analysis_duration_ms))}</p>`}<div class="af-table-scroll"><table class="af-table af-table--wrap report-table"><thead><tr><th>Кластер</th><th>Профиль</th><th>Основная оценка</th><th>Диапазон по доступным сведениям</th><th>Охват критериев</th></tr></thead><tbody>${rows || '<tr><td colspan="5">Оценки ещё не сформированы.</td></tr>'}</tbody></table></div>${analyses.join("")}`;
}

export function ratingAnalysisHtml(rating: ReportRating) {
  const analysis = ratingAnalysis(rating);
  const text = (value: string) => escapeHtml(value).replace(/\n/g, "<br>");
  const quotes = (items: string[]) => items.map(quote => `<blockquote>${text(quote)}</blockquote>`).join("");
  const groups = analysis.groups.filter(group => group.items.length).map(group => `<section><h4>${escapeHtml(group.title)}</h4><ul>${group.items.map(item => `<li><span class="criterion-category">${escapeHtml(item.category)}</span><strong>${escapeHtml(item.requirement)}</strong>${item.notes.length ? `<p>${escapeHtml(item.notes.join(" "))}</p>` : ""}${item.quotes.length ? quotes([item.quotes.join("\n")]) : ""}</li>`).join("")}</ul></section>`).join("");
  const metrics = analysis.evidence ? `<dl><div><dt>Диапазон оценки</dt><dd>${escapeHtml(analysis.range)} / 100</dd></div><div><dt>Охват критериев</dt><dd>${analysis.evidence.coverage}%</dd></div></dl>${analysis.evidence.context_truncated ? '<p class="af-alert af-alert--warning">Оценён только фрагмент резюме.</p>' : ""}` : "";
  const knownStops = analysis.stops.filter(stop => stop.state !== "unknown");
  const stops = knownStops.length ? `<ul>${knownStops.map(stop => `<li><strong>${escapeHtml(stop.requirement)}</strong><p>${escapeHtml(stop.status)}. ${escapeHtml(stop.notes)}</p>${quotes([stop.quotes.join("\n")])}</li>`).join("")}</ul>` : `<p>${escapeHtml(analysis.stops.length ? "Не указано" : rating.triggered_stop_factors?.join("; ") || "Не заданы")}</p>`;
  const skills = analysis.skills.length ? `<h4>Навыки</h4>${analysis.skills.map(group => `<p>${escapeHtml(group.title)}: ${group.items.map(item => escapeHtml(item.requirement)).join(", ")}</p>${quotes([...new Set(group.items.flatMap(item => item.quotes))])}`).join("")}` : "";
  const missing = analysis.missing.length ? `<dl class="missing-fields">${analysis.missing.map(field => `<div><dt>${escapeHtml(field.label)}</dt><dd>Не указано</dd></div>`).join("")}</dl>` : "";
  return `${metrics}${groups ? `<h4>Обоснование оценки</h4>${groups}` : !analysis.evidence ? `<h4>Обоснование оценки</h4><p>${text(analysis.legacyExplanation)}</p>` : ""}${skills}${missing}<h4>Стоп-факторы</h4>${stops}`;
}
export function reportHtml(candidate: Candidate, clusters: Cluster[], print: boolean, tablesOnly = false, controls = false) {
  const toolbar = controls ? `<form class="report-controls" action="/api/resumes/${escapeHtml(candidate.resume_id)}/report" method="get"><label>Содержание<select name="content"><option value="report"${!tablesOnly ? " selected" : ""}>Полный отчёт</option><option value="table"${tablesOnly ? " selected" : ""}>Только таблицы</option></select></label><label>Формат экспорта<select name="format"><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV (.csv)</option><option value="html">HTML (.html)</option></select></label><button type="submit" name="download" value="true">Скачать</button><button type="submit" name="print" value="true">Печать / PDF</button></form>` : "";
  return htmlDocument(`Отчёт · ${fullName(candidate) || "ФИО не указано"}`, toolbar + reportContent(candidate, clusters, tablesOnly), print);
}
