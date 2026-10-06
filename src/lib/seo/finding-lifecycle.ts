import type {
  SeoActionKind,
  SeoFindingStatus,
} from "@/lib/seo/opportunity-types";

// SEO fırsat bulgularının yaşam döngüsü (docs/search-opportunities.md "Bulgu
// yaşam döngüsü"). Saf: motor (findings-store.ts) mevcut satırları ve bu
// koşunun taslaklarını verir, plan yazılacakları söyler. Parmak izi kural +
// konu + dönemdir; aynı fırsat yeni haftada yeni satırdır, eskisi SUPERSEDED
// olur ve çıktıları (açıklama, sinyal, fikir bağları) yeni satıra taşınır.
// Kural değerlendirildi ve konu artık görülmüyorsa RESOLVED; değerlendirilemeyen
// kuralın 35 gündür görülmeyen satırı EXPIRED. Sınır yüzünden taslağa
// girmeyen ama hâlâ görülen konunun satırına yalnız lastSeenAt yazılır.

export const SUPPRESS_DISMISSED_DAYS = 56;
export const DONE_FALLBACK_DAYS = 28;
export const ACCEPTED_HOLD_DAYS = 90;
export const EXPIRE_UNSEEN_DAYS = 35;
export const FINDING_RETENTION_DAYS = 730;
export const DECIDED_LOOKBACK_DAYS = 120;

// DONE sonrası değerlendirme penceresi (gün); INVESTIGATE için yok (geri
// dönüş DONE_FALLBACK_DAYS'e düşer).
export const EVALUATION_WINDOW_DAYS: Readonly<
  Record<SeoActionKind, number | null>
> = {
  TITLE_META: 28,
  CONTENT_REFRESH: 56,
  NEW_CONTENT: 90,
  INTERNAL_LINKS: 42,
  CONSOLIDATE: 56,
  TECH_FIX: 28,
  SCHEMA: 28,
  LOCALIZE: 90,
  INVESTIGATE: null,
};

export type SeoDecision = "ACCEPT" | "DISMISS" | "DONE";

const DAY_MS = 86_400_000;

// Kullanıcı kararının geçişi; geçersizse null.
export function nextStatusFor(
  decision: SeoDecision,
  current: SeoFindingStatus,
): SeoFindingStatus | null {
  if (decision === "ACCEPT") return current === "OPEN" ? "ACCEPTED" : null;
  if (decision === "DISMISS") {
    return current === "OPEN" || current === "ACCEPTED" ? "DISMISSED" : null;
  }
  return current === "OPEN" || current === "ACCEPTED" ? "DONE" : null;
}

export type ExistingFindingRow = {
  id: string;
  fingerprint: string;
  ruleKey: string;
  subject: string;
  status: string;
  decidedAt: Date | null;
  evaluateAfter: Date | null;
  lastSeenAt: Date;
  shadow: boolean;
};

export type LifecyclePlan = {
  // carryFrom: yerine geçtiği OPEN satırın kimliği (aynı kural + konu), çıktı
  // taşıması için.
  create: { fingerprint: string; carryFrom: string | null }[];
  // reopen: RESOLVED | EXPIRED → OPEN
  update: {
    id: string;
    fingerprint: string;
    unshadow: boolean;
    reopen: boolean;
  }[];
  // lastSeenAt'i ilerletilecekler: sınır yüzünden taslağa girmeyen görülmüş
  // konuların OPEN satırları; taslağı bastıran ACCEPTED satırlar.
  touch: string[];
  supersede: string[];
  resolve: string[];
  expire: string[];
  suppressed: number;
};

type DraftKey = { fingerprint: string; ruleKey: string; subject: string };

function subjectKey(row: { ruleKey: string; subject: string }): string {
  return `${row.ruleKey}\u0000${row.subject}`;
}

// Aynı kural + konu için yeniden oluşturmayı engelleyen karar var mı.
// Dönüş: bastırmadıysa null; bastırdıysa dokunulacak satır kimliği (yalnız
// ACCEPTED) ya da "" (DISMISSED/DONE: dokunulmaz).
function suppressor(
  rows: readonly ExistingFindingRow[],
  now: Date,
): string | null {
  const nowMs = now.getTime();
  for (const row of rows) {
    if (row.status === "DISMISSED" && row.decidedAt) {
      if (row.decidedAt.getTime() >= nowMs - SUPPRESS_DISMISSED_DAYS * DAY_MS) {
        return "";
      }
    }
    if (row.status === "DONE") {
      const until =
        row.evaluateAfter?.getTime() ??
        (row.decidedAt
          ? row.decidedAt.getTime() + DONE_FALLBACK_DAYS * DAY_MS
          : null);
      if (until !== null && until > nowMs) return "";
    }
  }
  for (const row of rows) {
    if (row.status === "ACCEPTED" && row.decidedAt) {
      if (row.decidedAt.getTime() >= nowMs - ACCEPTED_HOLD_DAYS * DAY_MS) {
        return row.id;
      }
    }
  }
  return null;
}

function newestFirst(a: ExistingFindingRow, b: ExistingFindingRow): number {
  const diff = b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
  if (diff !== 0) return diff;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function planLifecycle(input: {
  drafts: readonly DraftKey[];
  seen: readonly { ruleKey: string; subject: string }[];
  existing: readonly ExistingFindingRow[];
  evaluated: readonly string[];
  mode: "shadow" | "on";
  now: Date;
}): LifecyclePlan {
  const plan: LifecyclePlan = {
    create: [],
    update: [],
    touch: [],
    supersede: [],
    resolve: [],
    expire: [],
    suppressed: 0,
  };
  // Bir satır yalnız bir listeye girer.
  const assigned = new Set<string>();
  const assign = (id: string, list: string[]) => {
    if (assigned.has(id)) return;
    assigned.add(id);
    list.push(id);
  };

  const byFingerprint = new Map<string, ExistingFindingRow>();
  const bySubject = new Map<string, ExistingFindingRow[]>();
  for (const row of input.existing) {
    byFingerprint.set(row.fingerprint, row);
    const key = subjectKey(row);
    const group = bySubject.get(key);
    if (group) group.push(row);
    else bySubject.set(key, [row]);
  }

  const seen = new Set(input.seen.map(subjectKey));
  const evaluated = new Set(input.evaluated);
  const drafted = new Set<string>();
  const planned = new Set<string>();

  for (const draft of input.drafts) {
    if (planned.has(draft.fingerprint)) continue;
    planned.add(draft.fingerprint);
    const key = subjectKey(draft);
    drafted.add(key);

    // 1. Parmak izi zaten var.
    const existing = byFingerprint.get(draft.fingerprint);
    if (existing) {
      if (assigned.has(existing.id)) continue;
      if (existing.status === "OPEN") {
        assigned.add(existing.id);
        plan.update.push({
          id: existing.id,
          fingerprint: existing.fingerprint,
          unshadow: input.mode === "on" && existing.shadow,
          reopen: false,
        });
      } else if (
        existing.status === "RESOLVED" ||
        existing.status === "EXPIRED"
      ) {
        assigned.add(existing.id);
        plan.update.push({
          id: existing.id,
          fingerprint: existing.fingerprint,
          unshadow: input.mode === "on" && existing.shadow,
          reopen: true,
        });
      } else {
        assign(existing.id, plan.touch);
      }
      continue;
    }

    // 2. Kullanıcı kararı yeniden oluşturmayı bastırır.
    const group = bySubject.get(key) ?? [];
    const suppressedBy = suppressor(group, input.now);
    if (suppressedBy !== null) {
      plan.suppressed += 1;
      if (suppressedBy !== "") assign(suppressedBy, plan.touch);
      continue;
    }

    // 3. Yeni satır; aynı konunun eski OPEN satırları SUPERSEDED.
    const open = group
      .filter((row) => row.status === "OPEN" && !assigned.has(row.id))
      .sort(newestFirst);
    plan.create.push({
      fingerprint: draft.fingerprint,
      carryFrom: open[0]?.id ?? null,
    });
    for (const row of open) assign(row.id, plan.supersede);
  }

  const nowMs = input.now.getTime();
  for (const row of input.existing) {
    if (row.status !== "OPEN" || assigned.has(row.id)) continue;
    const key = subjectKey(row);
    const stillSeen = seen.has(key) || drafted.has(key);
    // 4. Kural değerlendirildi, konu görülmedi.
    if (evaluated.has(row.ruleKey) && !stillSeen) {
      assign(row.id, plan.resolve);
      continue;
    }
    // 5. Görüldü ama taslak almadı (sınır ya da bastırma).
    if (stillSeen) {
      assign(row.id, plan.touch);
      continue;
    }
    // 6. Kural bu koşuda değerlendirilemedi ve uzun süredir görülmüyor.
    if (
      !evaluated.has(row.ruleKey) &&
      row.lastSeenAt.getTime() < nowMs - EXPIRE_UNSEEN_DAYS * DAY_MS
    ) {
      assign(row.id, plan.expire);
    }
  }
  return plan;
}
