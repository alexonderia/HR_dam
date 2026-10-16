import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";
const s3 = new S3Client(config.s3);
export async function fileDownloadUrl(bucket: string, key: string) {
  const expiresIn = 3600;
  return { download_url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn }),
    download_url_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString() };
}
export async function storedFileExists(bucket: string, key: string) {
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
  catch (error) { if ((error as { $metadata?: { httpStatusCode: number } }).$metadata?.httpStatusCode === 404) return false; throw error; }
}
export const putFile = (key: string, buffer: Buffer, mime: string, bucket = config.bucket) =>
  s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mime,
    }),
  );
export const deleteFile = (key: string) =>
  s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
export async function getFile(bucket: string, key: string) {
  const data = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  return Buffer.from(await data.Body!.transformToByteArray());
}
