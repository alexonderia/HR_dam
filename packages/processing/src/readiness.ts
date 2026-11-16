import type { AnalysisStatus } from "@hr/contracts";

const unavailable: AnalysisStatus = { available: false, alive: false, model_ready: false,
  broker_connected: false, busy: false,
  message: "Анализ временно недоступен. Принятые резюме ожидают восстановления обработки; повторная загрузка не требуется." };

// The worker reports model readiness separately from process liveness. A 200
// response or an AMQP consumer alone is insufficient evidence of availability.
export async function probeEvaluator(url = process.env.EVALUATOR_READY_URL || "http://resume-evaluator:8002/ready"): Promise<AnalysisStatus> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const body = await response.json() as Record<string, unknown>;
    const broker = body.broker as Record<string, unknown> | undefined;
    const available = response.ok && body.operation === "evaluate" && body.available === true &&
      body.alive === true && body.model_ready === true && broker?.guest === true && broker.authorized === true;
    return { ...unavailable, available, alive: body.alive === true, model_ready: body.model_ready === true,
      broker_connected: broker?.guest === true && broker.authorized === true, busy: body.busy === true,
      message: available ? body.busy === true ? "Идёт анализ резюме. Следующие задания ожидают очереди." : "Анализ резюме доступен." : unavailable.message };
  } catch { return { ...unavailable }; }
}
