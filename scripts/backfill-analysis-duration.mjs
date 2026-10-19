// Run inside the backend container after applying V4__analysis_duration.sql.
import { importAnalysisTiming } from "@hr/contracts";
import { brokerQueues, pool, readImportLedger, closeBroker } from "@hr/data-access";

let updated = 0;
try {
  const batches = (await brokerQueues()).filter(q => /^hr\.resume\.batch\.[a-f0-9-]{36}$/.test(q.name));
  for (const batch of batches) {
    const { events } = await readImportLedger(batch.name.slice("hr.resume.batch.".length));
    const receipts = await pool.query(`SELECT id,created_at FROM resume_events WHERE id=ANY($1::uuid[])
      AND event_type IN ('scored','scoring_failed') AND analysis_duration_ms IS NULL`,
    [[...new Set(events.map(event => event.job_id))]]);
    for (const receipt of receipts.rows) {
      const jobEvents = events.filter(event => event.job_id === receipt.id);
      const event = jobEvents.find(event => event.analysis_duration_ms != null) || jobEvents[0];
      const timing = importAnalysisTiming(events, event, receipt.created_at.toISOString());
      if (timing.analysis_duration_ms == null) continue;
      const result = await pool.query(`UPDATE resume_events SET analysis_duration_ms=$2
        WHERE id=$1 AND analysis_duration_ms IS NULL`, [receipt.id, timing.analysis_duration_ms]);
      updated += result.rowCount || 0;
    }
  }
  console.log(`Analysis durations restored: ${updated}`);
} finally {
  await closeBroker();
  await pool.end();
}
