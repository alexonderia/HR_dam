import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = resolve(process.argv[2] || ".secrets");
await mkdir(directory, { recursive: true });
for (const name of ["auth", "guest-job", "authorized-job", "guest-cookie"]) {
  let existing;
  try { existing = await readFile(resolve(directory, `${name}-private.pem`), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    const publicKey = createPublicKey(existing).export({ type: "spki", format: "pem" });
    try {
      const current = await readFile(resolve(directory, `${name}-public.pem`), "utf8");
      if (createPublicKey(current).export({ type: "spki", format: "pem" }) !== publicKey) throw new Error(`${name}: public and private keys do not match`);
    } catch (error) { if (error.code !== "ENOENT") throw error; await writeFile(resolve(directory, `${name}-public.pem`), publicKey, { flag: "wx", mode: 0o644 }); }
    console.log(`${name}: existing keys preserved`); continue;
  }
  const keys = generateKeyPairSync("rsa", { modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  await writeFile(resolve(directory, `${name}-private.pem`), keys.privateKey, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(directory, `${name}-public.pem`), keys.publicKey, { flag: "wx", mode: 0o644 });
  console.log(`${name}: keys generated`);
}
