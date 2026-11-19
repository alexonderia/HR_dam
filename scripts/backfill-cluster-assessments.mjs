// Baseline missing assessment snapshots in PostgreSQL after applying V5.
import { restoreClusterAssessmentHistory, pool } from "@hr/data-access";

try {
  console.log(JSON.stringify(await restoreClusterAssessmentHistory()));
} finally {
  await pool.end();
}
