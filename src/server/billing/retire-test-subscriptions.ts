import type { Prisma, PrismaClient } from "@prisma/client";

// `npm run billing:retire-test-subscriptions` (prisma/retire-test-subscriptions.ts) mantığı.
// Betik yalnız komut satırıdır; karar burada, test edilebilir yerde durur. `server-only` ve
// "@/" takma adı YOK: tsx ile komut satırından da yüklenir.
//
// Neden: test sürecinde biri test kartıyla (4242 ...) plan almış olabilir; BILLING_MODE=enforce
// açıldığında o satır ödenmiş süre bitene dek GERÇEK erişim verirdi (yıllıkta bir yıla kadar).

type Db = Pick<
  PrismaClient | Prisma.TransactionClient,
  "subscription" | "workspace" | "usageBalance"
>;

export type RetireCandidate = {
  workspaceId: string;
  planKey: string | null;
  interval: string | null;
  status: string;
  paidThrough: Date | null;
  // Workspace `BILLING_LEGACY_BEFORE`'dan önce açıldı: satırsız kalsaydı mevcut müşteri
  // (LEGACY, sınırsız) sayılırdı; emekli edilen satır onu İPTAL EDİLMİŞ (salt-okunur) yapar.
  wasLegacy: boolean;
  // Test kartıyla alınmış, hâlâ harcanabilir ek paket hakkı (süresiz; emekli edilince silinmez).
  extraLeft: number;
};

export type RetirePlan = {
  total: number;
  active: RetireCandidate[];
};

// Hangi veritabanına yazılacağı, kimlik bilgisi göstermeden.
export function describeDatabase(url: string | undefined): string {
  if (!url) return "(DATABASE_URL tanımlı değil)";
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, "") || "-";
    return `${parsed.hostname || "(yerel soket)"}${parsed.port ? `:${parsed.port}` : ""}/${database}`;
  } catch {
    return "(DATABASE_URL okunamadı)";
  }
}

// `BILLING_LEGACY_BEFORE` değeri (ISO 8601); geçersizse ya da boşsa null.
export function parseLegacyBefore(value: string | undefined): Date | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function planRetirement(
  db: Db,
  options: { now?: Date; legacyBefore?: Date | null } = {},
): Promise<RetirePlan> {
  const now = options.now ?? new Date();
  const rows = await db.subscription.findMany({
    where: { stripeLivemode: false, stripeSubscriptionId: { not: null } },
    select: {
      workspaceId: true,
      planKey: true,
      interval: true,
      status: true,
      paidThrough: true,
    },
    orderBy: { paidThrough: "desc" },
  });
  const active = rows.filter(
    (row) =>
      row.status !== "CANCELED" ||
      (row.paidThrough !== null && row.paidThrough.getTime() > now.getTime()),
  );
  const ids = active.map((row) => row.workspaceId);
  const [workspaces, balances] = await Promise.all([
    options.legacyBefore && ids.length > 0
      ? db.workspace.findMany({
          where: { id: { in: ids } },
          select: { id: true, createdAt: true },
        })
      : Promise.resolve([]),
    ids.length > 0
      ? db.usageBalance.findMany({
          where: { workspaceId: { in: ids } },
          select: {
            workspaceId: true,
            extraGranted: true,
            extraUsed: true,
            extraReserved: true,
          },
        })
      : Promise.resolve([]),
  ]);
  const createdAt = new Map(
    workspaces.map((workspace) => [workspace.id, workspace.createdAt]),
  );
  const extraLeft = new Map<string, number>();
  for (const balance of balances) {
    const left =
      balance.extraGranted - balance.extraUsed - balance.extraReserved;
    if (left > BigInt(0)) {
      extraLeft.set(
        balance.workspaceId,
        (extraLeft.get(balance.workspaceId) ?? 0) + Number(left),
      );
    }
  }
  return {
    total: rows.length,
    active: active.map((row) => ({
      ...row,
      wasLegacy:
        options.legacyBefore != null &&
        (createdAt.get(row.workspaceId)?.getTime() ?? Infinity) <
          options.legacyBefore.getTime(),
      extraLeft: extraLeft.get(row.workspaceId) ?? 0,
    })),
  };
}

// Emekli et: iptal edilmiş say ve ödenmiş süreyi şimdiye çek (canlı ödemeli satırlara
// `stripeLivemode: false` koşuluyla dokunulmaz). Tekrar çalıştırmak güvenlidir.
export async function retireCandidates(
  db: Db,
  candidates: ReadonlyArray<{ workspaceId: string }>,
  now: Date = new Date(),
): Promise<number> {
  let written = 0;
  for (const row of candidates) {
    const result = await db.subscription.updateMany({
      where: { workspaceId: row.workspaceId, stripeLivemode: false },
      data: {
        status: "CANCELED",
        endedAt: now,
        endedReason: "CANCELED",
        paidThrough: now,
        graceUntil: null,
        cancelAtPeriodEnd: false,
        pendingPlanKey: null,
        pendingInterval: null,
        pendingEffectiveAt: null,
      },
    });
    written += result.count;
  }
  return written;
}
