export const config = {
  db: {
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT || "http://127.0.0.1:8333",
    region: process.env.S3_REGION || "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY || "",
      secretAccessKey: process.env.S3_SECRET_KEY || "",
    },
    requestChecksumCalculation: "WHEN_REQUIRED" as const,
  },
  bucket: process.env.S3_BUCKET || "resumes",
};
