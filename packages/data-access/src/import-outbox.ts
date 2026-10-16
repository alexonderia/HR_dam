import { mkdir, readFile, writeFile, rename, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { importManifestSchema, storageJobSchema, type ImportManifest, type StorageJob } from "@hr/contracts";
import { publishQueue, publishImportEvent, batchQueue, queues } from "./queue.js";
import { spoolRoot, stagedFilePath } from "./spool.js";
import { processingMode } from "./processing-mode.js";

interface Outbox { mode: "broker" | "direct"; manifest: ImportManifest; jobs: StorageJob[] }
const publishing = new Map<string, Promise<void>>();
async function dispatch(path: string, outbox: Outbox) {
  if (outbox.mode !== processingMode) return;
  const existing = publishing.get(path);
  if (existing) return existing;
  const task = (async () => {
    await publishQueue(batchQueue(outbox.manifest.id), { kind: "manifest", manifest: outbox.manifest }, outbox.manifest.id);
    for (const job of outbox.jobs) {
      await publishImportEvent({ version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id,
        attempt: job.attempt, stage: "uploading", created_at: new Date().toISOString() });
      await publishQueue(queues.storage, job, job.job_id);
    }
    await unlink(path);
  })();
  publishing.set(path, task);
  try { await task; } finally { if (publishing.get(path) === task) publishing.delete(path); }
}
export async function enqueueImport(manifest: ImportManifest, buffers: Map<string, Buffer>, jobs?: StorageJob[]) {
  await mkdir(spoolRoot, { recursive: true });
  const staged: string[] = [];
  const path = join(spoolRoot, randomUUID() + ".outbox.json");
  let persisted = false;
  try {
    for (const [id, content] of buffers) {
      const target = stagedFilePath(id);
      await writeFile(target, content, { flag: "wx", mode: 0o600 });
      staged.push(target);
    }
    const outbox: Outbox = { mode: processingMode, manifest, jobs: jobs || manifest.items.map(file => ({
      version: 1, job_id: file.id, batch_id: manifest.id, item_id: file.id, attempt: 1, file, requirements: manifest.requirements,
    })) };
    await writeFile(path + ".tmp", JSON.stringify(outbox), { flag: "wx", mode: 0o600 });
    await rename(path + ".tmp", path);
    persisted = true;
    try { await dispatch(path, outbox); return true; }
    catch { return false; }
  } catch (error) {
    if (!persisted) {
      await Promise.all(staged.map(file => unlink(file).catch(() => {})));
      await unlink(path + ".tmp").catch(() => {});
    }
    throw error;
  }
}
export async function flushImportOutbox() {
  await mkdir(spoolRoot, { recursive: true });
  for (const name of await readdir(spoolRoot)) {
    if (!name.endsWith(".outbox.json")) continue;
    const path = join(spoolRoot, name);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Outbox;
      const outbox = { mode: parsed.mode || "broker" as const, manifest: importManifestSchema.parse(parsed.manifest), jobs: parsed.jobs.map(job => storageJobSchema.parse(job)) };
      await dispatch(path, outbox);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Pending resume upload retained for retry");
    }
  }
}
