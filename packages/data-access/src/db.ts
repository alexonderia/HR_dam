import pg from "pg";
import { config } from "./config.js";
import { MOSCOW_TIME_ZONE } from "@hr/contracts";
export const pool = new pg.Pool({
  ...config.db,
  options: `-c timezone=${MOSCOW_TIME_ZONE}`,
  max: 10,
  connectionTimeoutMillis: 5000,
});
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
