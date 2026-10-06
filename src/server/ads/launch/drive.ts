import "server-only";

import { ExecutionService } from "@/server/execution/execution-service";
import { OutboxRepository } from "@/server/repositories/outbox.repository";

// Onaydan hemen sonra lansmanı süren döngü (docs/meta-ads-plan.md §3.4
// "Satır içi sürüş"): onay eylemi `after()` ile çağırır, istek beklemez. Olay
// outbox'tan önce alınır (işçi aynı işi ikinci kez başlatmaz); iş başlatılır
// ve RUNNING kaldıkça yoklanır. Süre dolarsa işçinin yoklaması devralır;
// adım makinesinin kilidi iki tarafın aynı anda yazmasını önler.

const POLL_MS = 1_500;

export async function driveLaunchInline(
  jobId: string,
  budgetMs = 240_000,
): Promise<void> {
  try {
    const ownership = await OutboxRepository.claimDispatchForInline(jobId);
    if (ownership === "worker") return;
    const started = await ExecutionService.startExecution(jobId, "HIGH");
    let status = started.status;
    const deadline = Date.now() + budgetMs;
    while (status === "RUNNING" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      status = (await ExecutionService.pollOnce(jobId)).status;
    }
  } catch (error) {
    // İşçi kaldığı yerden devralır.
    console.error(
      "[ads-launch] inline drive stopped:",
      error instanceof Error ? error.message : error,
    );
  }
}
