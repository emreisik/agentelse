import "server-only";

import { prisma } from "@/lib/prisma";
import { formatDay } from "@/lib/billing/catalog";

import { getBillingConfig } from "./config";
import { getEntitlements } from "./entitlements";
import { getUsageView } from "./ledger";

// Fikir panosu, SEO içerik planı ve marka terimi önerisi gibi yüzeyler, motorun
// BUDGET_EXCEEDED'ını kaba bir "bütçe" nedenine indirir ve "yarın gelir / Ayarlar'dan
// yükselt" der. Bu GÜNLÜK sayaç için doğrudur (ertesi gün açılır, ayardan yükseltilir);
// PLAN HAKKI bittiğinde yanlıştır: o, dönem yenilenene ya da ek paket gelene kadar kapalı
// kalır ve ayarda yükseltilecek bir şey yoktur. Neden motor katmanında kaybolduğu için,
// eylem katmanı mesajı seçerken workspace'in ŞU ANKİ plan durumuna bakar.
//
// Hiç fırlatmaz: okunamazsa günlük sayaç hikâyesi (eski davranış) kalır. Müşteriye token ya
// da dolar gösterilmez.

export type BudgetStopCause =
  | { kind: "daily" }
  // `trial`: the allowance is a free trial's. It does not renew; the person chooses a plan.
  | { kind: "allowance"; resetsAt: string | null; trial?: boolean }
  | { kind: "no-plan" };

export async function budgetStopCause(
  workspaceId: string,
  now: Date = new Date(),
): Promise<BudgetStopCause> {
  try {
    if (getBillingConfig().mode !== "enforce") return { kind: "daily" };
    const entitlements = await getEntitlements(workspaceId, { now });
    // Okunamadı ya da kota uygulanmıyor (LEGACY / muaf): plan hakkı bir neden olamaz.
    if (entitlements.reason === "DEGRADED" || entitlements.unlimited) {
      return { kind: "daily" };
    }
    if (entitlements.access !== "FULL") return { kind: "no-plan" };
    const ai = (await getUsageView(workspaceId, { now })).find(
      (view) => view.unit === "AI_MICROS",
    );
    if (ai && ai.available <= 0) {
      return {
        kind: "allowance",
        resetsAt: ai.period.endsAt,
        ...(entitlements.isTrial ? { trial: true } : {}),
      };
    }
    return { kind: "daily" };
  } catch {
    return { kind: "daily" };
  }
}

// Saf: nedene göre cümle. `dailyMessage` günlük sayaç hikâyesidir (yüzeyin kendi metni).
export function budgetStopMessage(
  cause: BudgetStopCause,
  dailyMessage: string,
): string {
  switch (cause.kind) {
    case "allowance": {
      if (cause.trial) {
        return "Your free trial's AI usage is used up. Choose a plan in Plan & usage to keep creating.";
      }
      const renews = cause.resetsAt
        ? `; it renews on ${formatDay(cause.resetsAt, { year: false })}`
        : "";
      return `Your plan's AI usage for this period is used up${renews}. You can add more in Plan & usage, or wait for the renewal.`;
    }
    case "no-plan":
      return "This workspace has no active plan, so new AI work can't start right now. Choose a plan in Plan & usage.";
    default:
      return dailyMessage;
  }
}

export async function budgetMessage(
  workspaceId: string,
  dailyMessage: string,
): Promise<string> {
  return budgetStopMessage(await budgetStopCause(workspaceId), dailyMessage);
}

// Eylemin elinde yalnız proje kimliği varsa.
export async function budgetMessageForProject(
  projectId: string,
  dailyMessage: string,
): Promise<string> {
  try {
    if (getBillingConfig().mode !== "enforce") return dailyMessage;
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    return project
      ? budgetMessage(project.workspaceId, dailyMessage)
      : dailyMessage;
  } catch {
    return dailyMessage;
  }
}
