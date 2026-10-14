import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Download, Printer } from "lucide-react";
import { Button, PageHeading } from "../components/ui";
import guide from "../content/user-guide.md?raw";

// This bundled document uses headings, paragraphs, lists, tables and callouts.
// Render its text as React children so document content never becomes raw HTML.
const sections = guide.trim().split(/^## /m).slice(1).map((section, index) => {
  const [title, ...body] = section.trim().split("\n");
  return { id: `guide-section-${index + 1}`, title, body: body.join("\n") };
});
const introduction = guide.split(/^## /m)[0].trim().split(/\n\s*\n/).slice(1);

function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(\/[^)\s]*\))/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    const link = /^\[([^\]]+)\]\((\/[^)\s]*)\)$/.exec(part);
    return link ? <Link key={index} className="af-link" to={link[2]}>{link[1]}</Link> : part;
  });
}

function block(text: string, index: number): ReactNode {
  const lines = text.trim().split("\n");
  if (lines[0].startsWith("|")) {
    const rows = lines.map(line => line.trim().slice(1, -1).split("|").map(cell => cell.trim()));
    return (
      <div key={index} className="af-table-scroll guide-table">
        <table className="af-table">
          <thead><tr>{rows[0].map((cell, i) => <th key={i} scope="col">{inline(cell)}</th>)}</tr></thead>
          <tbody>{rows.slice(2).map((row, i) => (
            <tr key={i}>{row.map((cell, j) => <td key={j}>{inline(cell)}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    );
  }
  if (lines.every(line => /^\d+\. /.test(line))) {
    return <ol key={index}>{lines.map((line, i) => <li key={i}>{inline(line.replace(/^\d+\. /, ""))}</li>)}</ol>;
  }
  if (lines.every(line => line.startsWith("- "))) {
    return <ul key={index}>{lines.map((line, i) => <li key={i}>{inline(line.slice(2))}</li>)}</ul>;
  }
  if (lines[0].startsWith("> ")) {
    return <div key={index} className="af-alert af-alert--info guide-callout">{inline(lines.map(line => line.replace(/^> /, "")).join(" "))}</div>;
  }
  return <p key={index}>{inline(lines.join(" "))}</p>;
}

function downloadGuide() {
  const url = URL.createObjectURL(new Blob([guide], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "HR-DAM-памятка-пользователя.md";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function Help() {
  return (
    <>
      <PageHeading
        eyebrow="Помощь в работе"
        title="Памятка пользователя"
        text="От настройки требований до завершения отбора: функции системы, порядок действий и ответы на частые вопросы."
        actions={
          <div className="toolbar">
            <Button secondary onClick={downloadGuide}><Download size={16} />Скачать памятку</Button>
            <Button secondary onClick={() => window.print()}><Printer size={16} />Печать / PDF</Button>
          </div>
        }
      />
      <div className="guide-layout">
        <nav className="af-card guide-contents no-print" aria-label="Оглавление памятки">
          <h2 className="af-title">Содержание</h2>
          <ol>{sections.map(section => (
            <li key={section.id}><a className="af-link" href={`#${section.id}`}>{section.title}</a></li>
          ))}</ol>
        </nav>
        <article className="af-card guide-document" aria-label="Руководство пользователя HR DAM">
          <div className="guide-introduction">{introduction.map((text, i) => block(text, i))}</div>
          {sections.map(section => (
            <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
              <h2 className="af-title" id={`${section.id}-title`}>{section.title}</h2>
              {section.body.trim().split(/\n\s*\n/).map(block)}
            </section>
          ))}
        </article>
      </div>
    </>
  );
}
