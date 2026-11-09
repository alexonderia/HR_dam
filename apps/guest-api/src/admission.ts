import { randomUUID } from "node:crypto";
import { AccessError } from "@hr/security";
import type { ObjectStore } from "@hr/processing";

interface Ticket { id: string; owner: string; files: number; bytes: number; created_at: number; expires_at: number; admitted_at?: number; task_id?: string; upload_id?: string }
interface Admission { revision: number; tickets: Ticket[] }
export class AdmissionQueue {
  constructor(readonly objects: ObjectStore, readonly capacity = Number(process.env.GUEST_UPLOAD_CONCURRENCY || 3)) {}
  async change<T>(fn: (queue: Admission, now: number) => T) {
    for (let i = 0; i < 30; i++) {
      const old = await this.objects.json<Admission>("admission/state.json");
      const queue = old?.value || { revision: 0, tickets: [] }, now = Date.now();
      queue.tickets = queue.tickets.filter(t => t.expires_at > now);
      let slots = this.capacity - queue.tickets.filter(t => t.admitted_at).length;
      for (const ticket of queue.tickets) if (!ticket.admitted_at && slots > 0) {
        ticket.admitted_at = now; ticket.expires_at = now + 600000; slots--;
      }
      const result = fn(queue, now); queue.revision++;
      if (await this.objects.conditional("admission/state.json", queue, old?.version || null)) return result;
    }
    throw new AccessError(503, "Очередь занята. Повторите запрос.");
  }
  async enqueue(owner: string, files: number, bytes: number) {
    const id = randomUUID();
    await this.change((queue, now) => {
      if (queue.tickets.length >= 1000 || queue.tickets.filter(t => t.owner === owner).length >= 3) throw new AccessError(429, "Лимит ожидающих загрузок исчерпан.");
      queue.tickets.push({ id, owner, files, bytes, created_at: now, expires_at: now + 900000 });
    });
    return this.status(id, owner);
  }
  status(id: string, owner: string) {
    return this.change(queue => {
      const ticket = queue.tickets.find(t => t.id === id && t.owner === owner);
      if (!ticket) throw new AccessError(404, "Разрешение не найдено или истекло.");
      return { id, status: ticket.admitted_at ? "admitted" : "waiting", position: queue.tickets.filter(t => !t.admitted_at).findIndex(t => t.id === id) + 1,
        expires_at: new Date(ticket.expires_at).toISOString() };
    });
  }
  claim(id: string, owner: string, taskId: string) {
    return this.change(queue => {
      const ticket = queue.tickets.find(t => t.id === id && t.owner === owner);
      if (!ticket?.admitted_at || (ticket.task_id && ticket.task_id !== taskId)) throw new AccessError(409, "Дождитесь допуска к загрузке.");
      ticket.task_id = taskId; return { files: ticket.files, bytes: ticket.bytes };
    });
  }
  start(id: string, owner: string, taskId: string, duplicate: boolean) {
    return this.change((queue, now) => {
      let ticket = queue.tickets.find(t => t.id === id && t.owner === owner);
      if (!ticket && duplicate) {
        if (queue.tickets.filter(t => t.admitted_at).length >= this.capacity) throw new AccessError(429, "Все места загрузки заняты. Повторите запрос позже.");
        ticket = { id, owner, task_id: taskId, files: 0, bytes: 0, created_at: now, admitted_at: now, expires_at: now + 600000 };
        queue.tickets.push(ticket);
      }
      if (!ticket?.admitted_at || (ticket.task_id && ticket.task_id !== taskId)) throw new AccessError(409, "Допуск истёк или принадлежит другой отправке.");
      if (ticket.upload_id) throw new AccessError(429, "Эта отправка уже загружается.");
      ticket.task_id = taskId; ticket.upload_id = randomUUID();
      return { files: ticket.files, bytes: ticket.bytes };
    });
  }
  release(id: string, owner: string) { return this.change(queue => { queue.tickets = queue.tickets.filter(t => t.id !== id || t.owner !== owner); }); }
}
