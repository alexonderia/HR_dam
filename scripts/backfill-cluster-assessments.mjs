// Run inside the updated backend container after applying V5.
import { restoreClusterAssessmentHistory, closeBroker, pool } from "@hr/data-access";

try {
  console.log(JSON.stringify(await restoreClusterAssessmentHistory()));
} finally {
  await closeBroker();
  await pool.end();
}
