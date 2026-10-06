// İşçi kesintisinden sonra kuyrukta ne biriktiğini gösteren SALT OKUNUR rapor
// (docs/meta-ads-plan.md F0a, K2). Hiçbir satırı değiştirmez.
//
//   npm run db:report:backlog
//
// Sahip bu raporu okuyup K2 kararını verir; ardından işçi açılır. Bayat Meta
// yazmalarını işçinin claim noktasındaki kapı zaten iptal eder
// (src/server/execution/backlog-gate.ts); bu rapor neyin iptal edileceğini,
// neyin çalışacağını önceden gösterir.

import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

import { PrismaClient } from "@prisma/client";

import {
  isMetaSpendWrite,
  staleWriteReason,
} from "../src/lib/execution-backlog";

const prisma = new PrismaClient();
const now = new Date();
const DAY_MS = 24 * 60 * 60_000;

function age(date: Date | null | undefined): string {
  if (!date) return "-";
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 120) return `${minutes} dk`;
  const hours = Math.round(minutes / 60);
  if (hours < 72) return `${hours} sa`;
  return `${Math.round(hours / 24)} gün`;
}

function heading(title: string) {
  console.log(`\n## ${title}`);
}

async function executionJobs() {
  heading("Bekleyen yürütme işleri (ExecutionJob)");
  const jobs = await prisma.executionJob.findMany({
    where: {
      status: { in: ["QUEUED", "RUNNING", "WAITING_PROVIDER", "VERIFYING"] },
    },
    select: {
      status: true,
      capability: true,
      createdAt: true,
      projectId: true,
      taskId: true,
      task: { select: { createdAt: true, title: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (jobs.length === 0) {
    console.log("Yok.");
    return;
  }

  const byKey = new Map<string, { count: number; oldest: Date }>();
  for (const job of jobs) {
    const key = `${job.status} · ${job.capability}`;
    const entry = byKey.get(key);
    if (!entry) byKey.set(key, { count: 1, oldest: job.createdAt });
    else entry.count += 1;
  }
  for (const [key, entry] of byKey) {
    console.log(`- ${key}: ${entry.count} (en eskisi ${age(entry.oldest)})`);
  }

  const metaJobs = jobs.filter(
    (job) => job.status === "QUEUED" && isMetaSpendWrite(job.capability),
  );
  if (metaJobs.length === 0) return;

  heading("Bekleyen Meta yazmaları: kapı ne yapacak?");
  for (const job of metaJobs) {
    const approval = await prisma.approval.findFirst({
      where: { taskId: job.taskId, status: "APPROVED" },
      orderBy: { reviewedAt: "desc" },
      select: { reviewedAt: true },
    });
    const reason = job.task
      ? staleWriteReason({
          capability: job.capability,
          taskCreatedAt: job.task.createdAt,
          approvedAt: approval?.reviewedAt ?? null,
          now,
        })
      : null;
    console.log(
      `- ${job.capability} "${job.task?.title ?? "?"}" (proje ${job.projectId}): ${
        reason ? `İPTAL EDİLİR (${reason})` : "çalışır"
      }`,
    );
  }
}

async function outbox() {
  heading("Bekleyen outbox olayları");
  const events = await prisma.outboxEvent.groupBy({
    by: ["eventType", "status"],
    where: { status: { in: ["PENDING", "PROCESSING"] } },
    _count: { _all: true },
    _min: { createdAt: true },
  });
  if (events.length === 0) console.log("Yok.");
  for (const row of events) {
    console.log(
      `- ${row.status} · ${row.eventType}: ${row._count._all} (en eskisi ${age(row._min.createdAt)})`,
    );
  }
}

async function approvals() {
  heading("Karar bekleyen onaylar");
  const pending = await prisma.approval.findMany({
    where: { status: "PENDING" },
    select: { type: true, level: true, createdAt: true, expiresAt: true },
  });
  if (pending.length === 0) {
    console.log("Yok.");
    return;
  }
  const byKey = new Map<string, { count: number; old: number; oldest: Date }>();
  for (const row of pending) {
    const key = `${row.type} · ${row.level ?? "LEVEL_3_CLIENT"}`;
    const isOld = now.getTime() - row.createdAt.getTime() > 3 * DAY_MS;
    const entry = byKey.get(key);
    if (!entry) {
      byKey.set(key, { count: 1, old: isOld ? 1 : 0, oldest: row.createdAt });
    } else {
      entry.count += 1;
      if (isOld) entry.old += 1;
    }
  }
  for (const [key, entry] of byKey) {
    console.log(
      `- ${key}: ${entry.count} (72 saatten eski: ${entry.old}; en eskisi ${age(entry.oldest)})`,
    );
  }
}

async function scheduledPublishing() {
  heading("Zamanı gelmiş onaylı yayınlar");
  const due = await prisma.creative.findMany({
    where: {
      status: "APPROVED",
      excludedAt: null,
      scheduledFor: { lte: now },
    },
    select: { platform: true, scheduledFor: true },
  });
  const fresh = due.filter(
    (row) =>
      row.scheduledFor && now.getTime() - row.scheduledFor.getTime() <= DAY_MS,
  );
  const stale = due.length - fresh.length;
  console.log(
    `- Son 24 saat içinde zamanı gelen (işçi açılınca çıkar): ${fresh.length}`,
  );
  console.log(
    `- Zamanı 24 saatten eski (çıkmaz, takvimde "Missed" kalır): ${stale}`,
  );

  const schedules = await prisma.projectSchedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    select: { name: true, capability: true, nextRunAt: true },
  });
  heading("Vadesi geçmiş zamanlanmış görevler (ProjectSchedule)");
  if (schedules.length === 0) console.log("Yok.");
  for (const row of schedules) {
    console.log(
      `- ${row.capability} "${row.name}": ${age(row.nextRunAt)} gecikmiş (işçi açılınca bir kez çalışır)`,
    );
  }
}

async function agencyLoop() {
  heading("Ajans döngüsü (LLM'li adımlar dahil)");
  const triggers = await prisma.agencyTrigger.groupBy({
    by: ["type"],
    where: { status: "PENDING" },
    _count: { _all: true },
    _min: { createdAt: true },
  });
  if (triggers.length === 0) console.log("Bekleyen tetik yok.");
  for (const row of triggers) {
    console.log(
      `- ${row.type}: ${row._count._all} (en eskisi ${age(row._min.createdAt)})`,
    );
  }
  const loops = await prisma.agencyLoopState.findMany({
    select: { lastTickAt: true },
    orderBy: { lastTickAt: "desc" },
    take: 1,
  });
  console.log(
    `- Son ajans tick'i: ${loops[0]?.lastTickAt?.toISOString() ?? "hiç"} (${age(loops[0]?.lastTickAt)} önce)`,
  );
}

async function main() {
  console.log(`# İşçi birikim raporu · ${now.toISOString()}`);
  await executionJobs();
  await outbox();
  await approvals();
  await scheduledPublishing();
  await agencyLoop();
  console.log(
    '\nNot: Bu rapor hiçbir şeyi değiştirmedi. Bayat Meta yazmaları işçi açılınca kapıda iptal edilir; kartları "Approve again" ile yeniden onaylanabilir.',
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
