import { ObjectStore, GuestTaskStore, ProcessingBroker, ProcessingEngine } from "@hr/processing";
import { keyFromEnv, cookieSettings } from "@hr/security";
import { GuestService } from "./service.js";
import { createGuestApp } from "./app.js";

const objects = new ObjectStore("guest-temporary", "GUEST_S3"), store = new GuestTaskStore(objects);
let engine: ProcessingEngine;
const broker = new ProcessingBroker(process.env.PROCESSING_AMQP_URL || "", "guest", (task, id) => engine.token(task.jobs.find(j => j.job_id === id)!));
engine = new ProcessingEngine("guest", store, objects, broker, { privateKey: keyFromEnv("GUEST_JOB_PRIVATE_KEY"), publicKey: keyFromEnv("GUEST_JOB_PUBLIC_KEY") });
const service = new GuestService(objects, store, engine);
let ready = false, checking = false, cleaning = false;
const probe = async () => {
  if (ready || checking) return; checking = true;
  try { await objects.verifyAtomicWrites(); ready = true; } catch { console.error("Guest atomic-storage check failed; guest mode disabled"); }
  finally { checking = false; }
};
void probe(); const probeTimer = setInterval(() => void probe(), 10000);
const clean = async () => { if (!ready || cleaning) return; cleaning = true; try { await service.cleanup(); } catch { console.error("Guest cleanup failed; will retry"); } finally { cleaning = false; } };
const cleanupTimer = setInterval(() => void clean(), 30000);
const server = createGuestApp(service, { ...cookieSettings(), authPublicKey: keyFromEnv("AUTH_PUBLIC_KEY"), cookiePrivateKey: keyFromEnv("GUEST_COOKIE_PRIVATE_KEY"),
  cookiePublicKey: keyFromEnv("GUEST_COOKIE_PUBLIC_KEY"), ready: () => ready }).listen(Number(process.env.PORT || 3002), "0.0.0.0");
const stop = broker.start(engine);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { clearInterval(probeTimer); clearInterval(cleanupTimer); server.close(() => { void stop().then(() => process.exit(0)); }); });
