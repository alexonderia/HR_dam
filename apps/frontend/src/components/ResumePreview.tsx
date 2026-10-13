import { Download, ExternalLink, Printer } from "lucide-react";
import type { Candidate } from "@hr/contracts";
import { fileUrl, openWindow } from "../lib/api";
import { Button, Modal } from "./ui";

export function ResumePreview({
  candidate,
  onClose,
}: {
  candidate: Candidate;
  onClose: () => void;
}) {
  const pdf = candidate.mime_type === "application/pdf";
  return (
    <Modal title={candidate.file_name} onClose={onClose} wide>
      <div className="toolbar">
        <a
          className="af-btn af-btn--secondary"
          href={fileUrl(candidate.file_id, "download")}
        >
          <Download size={16} />
          Скачать
        </a>
        <Button
          secondary
          onClick={() => openWindow(fileUrl(candidate.file_id))}
        >
          <ExternalLink size={16} />В новом окне
        </Button>
        <Button
          secondary
          onClick={() => {
            if (pdf) {
              const frame = document.getElementById(
                "resume-frame",
              ) as HTMLIFrameElement;
              try {
                frame.contentWindow?.print();
              } catch {
                openWindow(fileUrl(candidate.file_id));
              }
            } else openWindow(fileUrl(candidate.file_id, "print"));
          }}
        >
          <Printer size={16} />
          Печать
        </Button>
      </div>
      {!pdf && (
        <p className="muted">
          Текстовый предпросмотр DOCX. Исходное оформление доступно в скачанном
          файле.
        </p>
      )}
      <iframe
        id="resume-frame"
        title="Предпросмотр резюме"
        src={fileUrl(candidate.file_id)}
        className="document-frame"
      />
    </Modal>
  );
}
