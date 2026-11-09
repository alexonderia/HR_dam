import amqp, { type ChannelModel, type ConfirmChannel, type Channel, type ConsumeMessage } from "amqplib";
import { ZodError } from "zod";
import { AccessError } from "@hr/security";
import type { ProcessingEngine } from "./engine.js";
import type { Publication, Publisher, Task } from "./types.js";

export const exchanges = { command: "hr.processing", event: "hr.processing.events", dead: "hr.processing.dead" };
export class ProcessingBroker implements Publisher {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private connecting?: Promise<void>;
  private consumers: Channel[] = [];
  private stopped = false;
  private onLost?: () => void;
  constructor(readonly url: string, readonly mode: "guest" | "authorized", readonly token: (task: Task, jobId: string) => string,
    readonly published?: (id: string) => Promise<void>) {}
  async connect() {
    if (this.channel) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const connection = await amqp.connect(this.url, { timeout: 5000 });
      connection.on("error", () => {});
      connection.once("close", () => { this.channel = undefined; this.connection = undefined; this.consumers = []; this.onLost?.(); });
      this.connection = connection;
      const channel = await connection.createConfirmChannel();
      channel.on("error", () => {});
      this.channel = channel;
    })();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  async publish(message: Publication, task: Task) {
    await this.connect();
    const channel = this.channel!;
    const id = message.kind === "command" ? message.body.job_id : message.body.event_id;
    const route = `${this.mode}.${message.kind === "command" ? message.body.operation : message.body.event_type}`;
    const ttl = Date.parse(message.body.deadline) - Date.now();
    if (ttl <= 0) throw new AccessError(409, "Время задания истекло.");
    await new Promise<void>((resolve, reject) => {
      let returned = false;
      const onReturn = (r: ConsumeMessage) => { if (r.properties.messageId === id) returned = true; };
      const onClose = () => done(new Error("Broker channel closed before confirm"));
      let settled = false;
      const done = (error?: unknown) => {
        if (settled) return; settled = true; clearTimeout(timer);
        channel.off("return", onReturn); channel.off("close", onClose);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => done(new Error("Publisher confirm timeout")), 10000);
      channel.on("return", onReturn); channel.once("close", onClose);
      try {
        channel.publish(exchanges[message.kind], route, Buffer.from(JSON.stringify(message.body)), {
          mandatory: true, persistent: true, contentType: "application/json", messageId: id,
          ...(this.mode === "guest" ? { expiration: String(Math.max(1, ttl)) } : {}),
          ...(message.kind === "command" ? { headers: { "x-job-token": this.token(task, message.body.job_id) } } : {}),
        }, error => done(error || (returned ? new Error("Message was unroutable") : undefined)));
      } catch (error) { done(error); }
    });
    await this.published?.(id);
  }
  start(engine: ProcessingEngine) {
    let running = false;
    const subscribe = async () => {
      if (running || this.stopped || this.consumers.length) return;
      running = true;
      try {
        await this.connect();
        for (const kind of ["events", "dead"] as const) {
          const channel = await this.connection!.createChannel();
          channel.on("error", () => {}); await channel.prefetch(kind === "dead" ? 1 : 4);
          this.consumers.push(channel);
          await channel.consume(`hr.${this.mode}.${kind}`, async message => {
            if (!message) return;
            try {
              const body = JSON.parse(message.content.toString("utf8"));
              if (kind === "events") await engine.event(body); else await engine.dead(body);
              channel.ack(message);
            } catch (error) {
              if (kind === "dead") {
                if (error instanceof SyntaxError || error instanceof ZodError) channel.ack(message);
                else {
                  // Pause DLQ accounting on storage failure. Channel close requeues the last message.
                  await channel.close().catch(() => {});
                  this.consumers = this.consumers.filter(c => c !== channel);
                  await this.connection?.close().catch(() => {});
                }
              } else channel.reject(message, !(error instanceof SyntaxError || error instanceof ZodError || (error instanceof AccessError && error.status < 500)));
            }
          }, { noAck: false });
        }
      } catch { await this.connection?.close().catch(() => {}); }
      finally { running = false; }
    };
    this.onLost = () => {};
    // Reconnect subscriptions only; domain retries and backoff belong to RabbitMQ.
    const timer = setInterval(() => void subscribe(), 5000);
    void subscribe();
    return async () => { this.stopped = true; clearInterval(timer); await this.connection?.close().catch(() => {}); };
  }
}
