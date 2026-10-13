import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { config } from "./config.js";
const s3 = new S3Client(config.s3);
export const putFile = (key: string, buffer: Buffer, mime: string) =>
  s3.send(
    new PutObjectCommand({
      Bucket: config.bucket,
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
