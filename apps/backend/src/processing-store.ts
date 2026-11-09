import { pool, transaction } from "@hr/data-access";
import type { PoolClient } from "pg";
import type { Task, Publication, TaskStore } from "@hr/processing";

export class AuthorizedTaskStore implements TaskStore {
  async outbox(client: PoolClient, task: Task, messages: Publication[]) {
    for (const message of messages) await client.query(`INSERT INTO processing_outbox(id,task_id,message) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`,
      [message.kind === "command" ? message.body.job_id : message.body.event_id, task.id, JSON.stringify(message)]);
  }
  async create(task: Task, messages: Publication[] = []) {
    await transaction(async client => {
      await client.query("INSERT INTO processing_tasks(id,state) VALUES($1,$2)", [task.id, JSON.stringify(task)]);
      await this.outbox(client, task, messages);
    });
  }
  async read(id: string) {
    const { rows } = await pool.query("SELECT state,version::text FROM processing_tasks WHERE id=$1", [id]);
    return rows[0] ? { task: rows[0].state as Task, version: rows[0].version as string } : null;
  }
  async replace(task: Task, version: string, messages: Publication[] = []) {
    return transaction(async client => {
      const result = await client.query("UPDATE processing_tasks SET state=$2,version=version+1 WHERE id=$1 AND version=$3 RETURNING id", [task.id, JSON.stringify(task), version]);
      if (!result.rowCount) return false;
      await this.outbox(client, task, messages); return true;
    });
  }
  async *list() {
    let cursor = "00000000-0000-0000-0000-000000000000";
    while (true) {
      const { rows } = await pool.query("SELECT id FROM processing_tasks WHERE id>$1 ORDER BY id LIMIT 100", [cursor]);
      if (!rows.length) return;
      for (const row of rows) { cursor = row.id; yield row.id as string; }
    }
  }
}
