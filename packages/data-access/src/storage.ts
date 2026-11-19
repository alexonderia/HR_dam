import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { config } from "./config.js";
const s3 = new S3Client(config.s3);
export async function getFile(bucket: string, key: string) {
  const data = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  return Buffer.from(await data.Body!.transformToByteArray());
}
