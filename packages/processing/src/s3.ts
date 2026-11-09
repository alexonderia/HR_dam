import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { BlobStore, Task, TaskStore } from "./types.js";

const status = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
export class ObjectStore implements BlobStore {
  readonly client: S3Client;
  constructor(readonly bucket: string, prefix = "S3") {
    this.client = new S3Client({ endpoint: process.env[`${prefix}_ENDPOINT`] || "http://127.0.0.1:8333",
      region: process.env[`${prefix}_REGION`] || "us-east-1", forcePathStyle: true,
      credentials: { accessKeyId: process.env[`${prefix}_ACCESS_KEY`] || "", secretAccessKey: process.env[`${prefix}_SECRET_KEY`] || "" },
      requestChecksumCalculation: "WHEN_REQUIRED", maxAttempts: 2,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 60000 } });
  }
  async put(key: string, source: Readable | Buffer, size: number, mime: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: source, ContentLength: size, ContentType: mime }));
  }
  async get(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return r.Body as Readable;
  }
  async remove(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
  async json<T>(key: string): Promise<{ value: T; version: string } | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!r.ETag) throw new Error("S3 response has no ETag");
      return { value: JSON.parse(await r.Body!.transformToString()), version: r.ETag };
    } catch (e) { if (status(e) === 404) return null; throw e; }
  }
  async conditional(key: string, value: unknown, version: string | null) {
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: JSON.stringify(value), ContentType: "application/json",
        ...(version === null ? { IfNoneMatch: "*" } : { IfMatch: version }) }));
      return true;
    } catch (e) { if ([409, 412].includes(status(e) || 0)) return false; throw e; }
  }
  async *keys(prefix: string) {
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 100 }));
      for (const item of r.Contents || []) if (item.Key) yield item.Key;
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }
  async verifyAtomicWrites() {
    // Test the deployed implementation. Merely sending If-Match is insufficient.
    const prefix = `probes/${randomUUID()}`;
    try {
      for (let round = 0; round < 5; round++) {
        const key = `${prefix}/${round}`;
        const created = await Promise.all(Array.from({ length: 8 }, (_, i) => this.conditional(key, { revision: i }, null)));
        if (created.filter(Boolean).length !== 1) throw new Error("S3 conditional create is not atomic; guest mode disabled");
        const current = await this.json(key);
        const written = await Promise.all(Array.from({ length: 8 }, (_, i) => this.conditional(key, { revision: 100 + i }, current!.version)));
        if (written.filter(Boolean).length !== 1) throw new Error("S3 compare-and-swap is not atomic; guest mode disabled");
      }
    } finally { for await (const key of this.keys(prefix)) await this.remove(key); }
  }
}
export class GuestTaskStore implements TaskStore {
  constructor(readonly objects: ObjectStore) {}
  async create(task: Task) {
    if (!await this.objects.conditional(`tasks/${task.id}/state.json`, task, null)) throw new Error("Task already exists");
  }
  async read(id: string) {
    const r = await this.objects.json<Task>(`tasks/${id}/state.json`);
    return r ? { task: r.value, version: r.version } : null;
  }
  replace(task: Task, version: string) { return this.objects.conditional(`tasks/${task.id}/state.json`, task, version); }
  async *list() {
    for await (const key of this.objects.keys("tasks/")) {
      const match = /^tasks\/([a-f0-9-]{36})\/state\.json$/.exec(key);
      if (match) yield match[1];
    }
  }
}
