import { randomUUID } from "node:crypto";
import { pool } from "@hr/data-access";
import { hashPassword } from "@hr/security";
const login = process.env.HR_USER_LOGIN?.trim().toLowerCase(), password = process.env.HR_USER_PASSWORD, name = process.env.HR_USER_NAME?.trim();
if (!login || !name || !password || password.length < 12) throw new Error("Set HR_USER_LOGIN, HR_USER_NAME and HR_USER_PASSWORD (at least 12 characters)");
try {
  await pool.query("INSERT INTO users(id,login,display_name,password_hash) VALUES($1,$2,$3,$4)", [randomUUID(), login, name, hashPassword(password)]);
  console.log("User created");
} finally { await pool.end(); }
