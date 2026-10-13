// Runs in a one-off backend container, using its installed AWS SDK and environment.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const require = createRequire("/app/packages/data-access/package.json");
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const client = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || "us-east-1",
  forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY } });
const Bucket = process.env.S3_BUCKET;
const root = "/snapshot/archive";
const state = "/snapshot/state/uploaded.json";
const metadataFields = ["ContentType", "ContentEncoding", "ContentDisposition", "CacheControl", "ContentLanguage", "Metadata"];

async function inventory() {
  const objects = [];
  let ContinuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
    for (const object of page.Contents || []) objects.push({ key: object.Key, size: object.Size, etag: object.ETag,
      modified: object.LastModified?.toISOString() });
    if (page.IsTruncated && !page.NextContinuationToken) throw new Error("Incomplete S3 pagination");
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return { bucket: Bucket, objects: objects.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) };
}

async function digest(body, destination) {
  const hash = createHash("sha256");
  let size = 0;
  const measure = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); size += chunk.length; callback(null, chunk); } });
  if (destination) await pipeline(body, measure, createWriteStream(destination, { flags: "wx" }));
  else {
    measure.resume();
    await pipeline(body, measure);
  }
  return { size, sha256: hash.digest("hex") };
}

async function manifest() {
  const data = JSON.parse(await readFile(root + "/s3.json", "utf8"));
  if (data.bucket !== Bucket) throw new Error("S3_BUCKET differs from backup");
  for (const obj of data.objects) {
    const expected = "objects/" + createHash("sha256").update(obj.key).digest("hex") + ".bin";
    if (obj.file !== expected) throw new Error("Invalid object file path");
  }
  return data;
}

async function main() {
  const action = process.argv[2];
  if (action === "inventory") return inventory();
  if (action === "backup") {
    const before = await inventory();
    await mkdir(root + "/objects");
    const objects = [];
    for (const obj of before.objects) {
      const response = await client.send(new GetObjectCommand({ Bucket, Key: obj.key }));
      const file = "objects/" + createHash("sha256").update(obj.key).digest("hex") + ".bin";
      const hash = await digest(response.Body, root + "/" + file);
      if (hash.size !== obj.size || response.ETag !== obj.etag) throw new Error("S3 object changed during backup");
      const metadata = Object.fromEntries(metadataFields.filter(k => response[k] !== undefined).map(k => [k, response[k]]));
      objects.push({ key: obj.key, file, ...hash, metadata });
    }
    if (JSON.stringify(before) !== JSON.stringify(await inventory())) throw new Error("S3 inventory changed during backup");
    const data = { bucket: Bucket, objects };
    await writeFile(root + "/s3.json", JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
    return data;
  }
  if (action === "restore") {
    const data = await manifest();
    if ((await inventory()).objects.length) throw new Error("S3 target must be empty");
    const uploaded = [];
    await writeFile(state, JSON.stringify(uploaded));
    for (const obj of data.objects) {
      const hash = await digest(createReadStream(root + "/" + obj.file));
      if (hash.sha256 !== obj.sha256 || hash.size !== obj.size) throw new Error("Backup object checksum mismatch");
      // Journal before PUT so a lost response still permits cleanup of this attempted key.
      uploaded.push(obj.key);
      await writeFile(state, JSON.stringify(uploaded));
      await client.send(new PutObjectCommand({ Bucket, Key: obj.key, Body: createReadStream(root + "/" + obj.file),
        ContentLength: obj.size, ...obj.metadata }));
    }
    return { uploaded: uploaded.length };
  }
  if (action === "rollback") {
    let uploaded;
    try { uploaded = JSON.parse(await readFile(state, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { deleted: 0 }; throw error; }
    const allowed = new Set((await manifest()).objects.map(obj => obj.key));
    if (!uploaded.every(key => allowed.has(key))) throw new Error("Invalid restore cleanup journal");
    for (const Key of uploaded) await client.send(new DeleteObjectCommand({ Bucket, Key }));
    return { deleted: uploaded.length };
  }
  if (action === "verify") {
    const data = await manifest();
    const current = await inventory();
    if (current.objects.length !== data.objects.length) throw new Error("Restored S3 object count differs");
    for (const obj of data.objects) {
      const response = await client.send(new GetObjectCommand({ Bucket, Key: obj.key }));
      const hash = await digest(response.Body);
      if (hash.sha256 !== obj.sha256 || hash.size !== obj.size) throw new Error("Restored object checksum mismatch");
      for (const key of Object.keys(obj.metadata)) {
        if (JSON.stringify(response[key]) !== JSON.stringify(obj.metadata[key])) throw new Error("Restored object metadata differs");
      }
    }
    return { verified: data.objects.length };
  }
  throw new Error("Unknown snapshot operation");
}

try { process.stdout.write(JSON.stringify(await main()) + "\n"); }
catch (error) { console.error("S3 snapshot failed:", error.name, error.message); process.exitCode = 1; }
finally { client.destroy(); }
