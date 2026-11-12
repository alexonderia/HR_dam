import reportStyles from "../styles/guest-report.css?inline";

export function downloadReport(element: HTMLElement) {
  const document = window.document.implementation.createHTMLDocument("Отчёт об оценке резюме");
  document.documentElement.lang = "ru";
  const charset = document.createElement("meta"); charset.setAttribute("charset", "utf-8"); document.head.prepend(charset);
  const viewport = document.createElement("meta"); viewport.name = "viewport"; viewport.content = "width=device-width, initial-scale=1"; document.head.append(viewport);
  const style = document.createElement("style");
  style.textContent = `body{margin:0;font:16px/1.5 Arial,sans-serif;color:#161616;background:#fff}*{box-sizing:border-box}h1{font-size:28px}h3,h5,h6{break-after:avoid}.af-alert--warning{padding:12px;background:#fff6e8}main>.guest-report-title{margin-bottom:24px;border:0!important;padding:0!important}` + reportStyles;
  document.head.append(style);
  const main = document.createElement("main"); main.className = "guest-page--report";
  const heading = element.closest(".guest-page--report")?.querySelector(".guest-report-title")?.cloneNode(true);
  const title = document.createElement("h1"); title.textContent = "Отчёт об оценке резюме";
  const report = element.cloneNode(true) as HTMLElement;
  report.removeAttribute("aria-live");
  report.querySelectorAll(".guest-actions, .guest-report-login, button, script").forEach(node => node.remove());
  report.querySelectorAll("[aria-live]").forEach(node => node.removeAttribute("aria-live"));
  report.querySelectorAll("details.guest-candidate, details.rating-sources").forEach(node => { node.removeAttribute("hidden"); node.setAttribute("open", ""); });
  main.append(heading || title, report); document.body.append(main);
  const url = URL.createObjectURL(new Blob(["<!doctype html>\n", document.documentElement.outerHTML], { type: "text/html;charset=utf-8" }));
  const link = window.document.createElement("a"); link.href = url; link.download = "resume-report.html";
  window.document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
