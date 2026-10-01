import "server-only";

import {
  DISCOVERY_CAPS,
  viewOf,
  type DiscoveryRecord,
  type DiscoveryView,
  type FieldId,
  type Row,
} from "@/lib/guided-discovery/contract";
import { safeModelText } from "@/lib/safe-model-text";

import type { DiscoveryAccess, DossierScope, DossierSnapshot } from "./flow";
import type { Change, Modified } from "./store";

// The discovery row's reads and the two taps that change it without any paid
// work: adding one "also found" chip to the dossier and confirming the profile
// (spec sections 5 and 7). Ground rules, each pinned by a test:
//  - A read writes nothing and starts nothing.
//  - The client sends ids only; the text that reaches the dossier is the text
//    the server stored in the row itself.
//  - The dossier is only ever filled: a list gets one more item (deduped, at
//    most 12), a text field is written only while it is empty.
//  - The audit rows carry the field name or counts, never a text.
//  - Everything with IO is injected, like flow.ts.

export const SERVICE_AUDIT = {
  candidateAdded: "guided_discovery.candidate_added",
  confirmed: "guided_discovery.confirmed",
} as const;

// One dossier list never grows past this through chips.
const LIST_CAP = 12;
// Reads back what a concurrent tap may have overwritten; two rounds are enough.
const WRITE_ROUNDS = 3;

type TextColumn = "summary" | "positioning" | "toneOfVoice";
type ListColumn = "targetAudiences" | "markets" | "products" | "services";

// Screen rows that have a dossier column. Competitors and channels have none
// (display only), so a tap on them changes nothing.
const TEXT_ROWS: Partial<Record<FieldId, TextColumn>> = {
  about: "summary",
  positioning: "positioning",
  voice: "toneOfVoice",
};
const LIST_ROWS: Partial<Record<FieldId, ListColumn>> = {
  audience: "targetAudiences",
  markets: "markets",
  products: "products",
  services: "services",
};

export type DossierWrite = Partial<Record<TextColumn, string>> &
  Partial<Record<ListColumn, string[]>>;

export type ServiceDeps = {
  nowMs: () => number;
  store: {
    read: (projectId: string) => Promise<DiscoveryRecord | null>;
    modify: <T>(
      projectId: string,
      change: (record: DiscoveryRecord) => Change<T>,
      options?: { attempts?: number },
    ) => Promise<Modified<T>>;
  };
  // null: the project has no default brand.
  readBrand: (
    projectId: string,
  ) => Promise<{ brandId: string; brandName: string } | null>;
  dossier: {
    read: (brandId: string) => Promise<DossierSnapshot>;
    write: (scope: DossierScope, data: DossierWrite) => Promise<void>;
  };
  audit: (entry: {
    workspaceId: string;
    projectId: string;
    brandId: string;
    action: string;
    actorId: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
};

export type DiscoveryState = {
  view: DiscoveryView | null;
  brandName: string;
};

export type AddResult =
  // The chip is in the dossier and marked added.
  | { kind: "ADDED"; view: DiscoveryView }
  // Nothing changed: unknown id, already added, a field that is no longer
  // empty, a full list, a row without a dossier column, a row not ready yet.
  | { kind: "NOOP"; view: DiscoveryView }
  | { kind: "NONE" };

export type ConfirmResult =
  | { kind: "CONFIRMED"; view: DiscoveryView }
  // Already confirmed before: nothing was written.
  | { kind: "UNCHANGED"; view: DiscoveryView }
  // Still running or failed: refused, nothing was written.
  | { kind: "NOT_READY"; view: DiscoveryView }
  | { kind: "NONE" };

function logError(what: string, error: unknown): void {
  console.error(
    `[guided-discovery] ${what}:`,
    error instanceof Error ? error.message : error,
  );
}

async function audit(
  deps: ServiceDeps,
  access: DiscoveryAccess,
  brandId: string,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.audit({
      workspaceId: access.workspaceId,
      projectId: access.projectId,
      brandId,
      action,
      actorId: access.userId,
      metadata,
    });
  } catch (error) {
    // The trail never turns a saved tap into a failure.
    logError("could not write the audit row", error);
  }
}

// --- reads ---------------------------------------------------------------------

// The row as the client sees it, plus the brand name the screen needs even
// when there is no row yet. Reads only. null: no brand, nothing to show.
export async function readDiscoveryState(
  projectId: string,
  deps?: ServiceDeps,
): Promise<DiscoveryState | null> {
  const d = deps ?? (await defaultDeps());
  const [brand, record] = await Promise.all([
    d.readBrand(projectId),
    d.store.read(projectId),
  ]);
  if (!brand) return null;
  return {
    view: record ? viewOf(record, d.nowMs(), brand.brandName) : null,
    brandName: brand.brandName,
  };
}

export async function readView(input: {
  access: DiscoveryAccess;
  deps?: ServiceDeps;
}): Promise<DiscoveryView | null> {
  const state = await readDiscoveryState(input.access.projectId, input.deps);
  return state?.view ?? null;
}

// --- add -----------------------------------------------------------------------

// Puts `text` into the dossier column for `field`, filling only. Returns true
// when the dossier holds the text afterwards (written now or already there).
async function ensureInDossier(
  d: ServiceDeps,
  scope: DossierScope,
  field: FieldId,
  text: string,
): Promise<boolean> {
  const folded = text.toLowerCase();
  const textColumn = TEXT_ROWS[field];
  const listColumn = LIST_ROWS[field];
  if (!textColumn && !listColumn) return false;

  for (let round = 0; round < WRITE_ROUNDS; round += 1) {
    // A fresh read each round: a person (or another tap) may have written since.
    const now = await d.dossier.read(scope.brandId);
    if (textColumn) {
      const current = now[textColumn].trim();
      if (current) return current.toLowerCase() === folded;
      await d.dossier.write(scope, { [textColumn]: text });
      continue;
    }
    if (listColumn) {
      const current = now[listColumn];
      if (current.some((item) => item.toLowerCase() === folded)) return true;
      if (current.length >= LIST_CAP) return false;
      await d.dossier.write(scope, { [listColumn]: [...current, text] });
    }
  }
  // Every round wrote but the value never showed up on the read back.
  return false;
}

function markAdded(record: DiscoveryRecord, candidateId: string): Change<null> {
  if (record.status !== "READY" && record.status !== "CONFIRMED") {
    return { error: "not_ready" };
  }
  let found = false;
  const rows = record.rows.map((row): Row => {
    const candidate = row.candidates.find((c) => c.id === candidateId);
    if (!candidate) return row;
    // Already added by a concurrent tap: this one is a no-op.
    if (candidate.added) return row;
    found = true;
    const folded = candidate.text.toLowerCase();
    const saved = row.saved.some((t) => t.toLowerCase() === folded)
      ? row.saved
      : [...row.saved, candidate.text];
    return {
      ...row,
      saved,
      candidates: row.candidates.map((c) =>
        c.id === candidateId ? { ...c, added: true } : c,
      ),
    };
  });
  if (!found) return { error: "unknown" };
  return { next: { ...record, rows }, value: null };
}

export async function addCandidate(input: {
  access: DiscoveryAccess;
  candidateId: string;
  deps?: ServiceDeps;
}): Promise<AddResult> {
  const d = input.deps ?? (await defaultDeps());
  const { access, candidateId } = input;
  const brand = await d.readBrand(access.projectId);
  const record = await d.store.read(access.projectId);
  if (!brand || !record) return { kind: "NONE" };

  const noop = (current: DiscoveryRecord): AddResult => ({
    kind: "NOOP",
    view: viewOf(current, d.nowMs(), brand.brandName),
  });

  if (record.status !== "READY" && record.status !== "CONFIRMED") {
    return noop(record);
  }
  const row = record.rows.find((r) =>
    r.candidates.some((c) => c.id === candidateId),
  );
  const candidate = row?.candidates.find((c) => c.id === candidateId);
  if (!row || !candidate || candidate.added) return noop(record);

  // The stored text, cleaned once more on its way into the dossier.
  const text = safeModelText(candidate.text, DISCOVERY_CAPS.textMax);
  if (!text) return noop(record);

  const scope: DossierScope = {
    workspaceId: access.workspaceId,
    projectId: access.projectId,
    brandId: brand.brandId,
  };
  if (!(await ensureInDossier(d, scope, row.field, text))) return noop(record);

  // The dossier write comes first: a crash in between leaves a saved value that
  // is not yet marked, and the next tap (idempotent) finishes the job.
  const modified = await d.store.modify(access.projectId, (current) =>
    markAdded(current, candidateId),
  );
  if (modified.status === "NONE") return { kind: "NONE" };
  if (modified.status === "REJECTED") {
    const current = await d.store.read(access.projectId);
    return current ? noop(current) : { kind: "NONE" };
  }

  await audit(d, access, brand.brandId, SERVICE_AUDIT.candidateAdded, {
    field: row.field,
  });
  return {
    kind: "ADDED",
    view: viewOf(modified.record, d.nowMs(), brand.brandName),
  };
}

// --- confirm -------------------------------------------------------------------

export async function confirmDiscovery(input: {
  access: DiscoveryAccess;
  deps?: ServiceDeps;
}): Promise<ConfirmResult> {
  const d = input.deps ?? (await defaultDeps());
  const { access } = input;
  const brand = await d.readBrand(access.projectId);
  if (!brand) return { kind: "NONE" };
  const nowMs = d.nowMs();

  const before = await d.store.read(access.projectId);
  if (!before) return { kind: "NONE" };
  // Idempotent: a second confirm writes nothing (confirmedAtMs keeps its first
  // value) and audits nothing.
  if (before.status === "CONFIRMED") {
    return {
      kind: "UNCHANGED",
      view: viewOf(before, nowMs, brand.brandName),
    };
  }

  const modified = await d.store.modify<null>(access.projectId, (record) => {
    if (record.status !== "READY") return { error: "not_ready" };
    return {
      next: {
        ...record,
        status: "CONFIRMED",
        confirmedAtMs: nowMs,
        updatedAtMs: nowMs,
      },
      value: null,
    };
  });

  if (modified.status === "NONE") return { kind: "NONE" };
  if (modified.status === "REJECTED") {
    const current = await d.store.read(access.projectId);
    if (!current) return { kind: "NONE" };
    const view = viewOf(current, nowMs, brand.brandName);
    // A concurrent confirm won: the outcome is the same.
    return current.status === "CONFIRMED"
      ? { kind: "UNCHANGED", view }
      : { kind: "NOT_READY", view };
  }

  await audit(d, access, brand.brandId, SERVICE_AUDIT.confirmed, {
    rows: modified.record.rows.length,
  });
  return {
    kind: "CONFIRMED",
    view: viewOf(modified.record, nowMs, brand.brandName),
  };
}

// --- production wiring ---------------------------------------------------------

// Built lazily, with dynamic imports: a caller that injects everything (the
// tests) never loads the database.
export async function defaultDeps(): Promise<ServiceDeps> {
  const [{ prisma }, store, auditRepo] = await Promise.all([
    import("@/lib/prisma"),
    import("./store"),
    import("@/server/repositories/audit-log.repository"),
  ]);

  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, LIST_CAP)
      : [];

  return {
    nowMs: () => Date.now(),
    store: {
      read: (projectId) => store.readDiscovery(projectId),
      modify: (projectId, change, options) =>
        store.modifyDiscovery(projectId, change, options),
    },
    readBrand: async (projectId) => {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          name: true,
          brands: {
            where: { isDefault: true },
            select: { id: true, name: true },
            take: 1,
          },
        },
      });
      const brand = project?.brands[0];
      if (!project || !brand) return null;
      return { brandId: brand.id, brandName: brand.name || project.name };
    },
    dossier: {
      read: async (brandId) => {
        const row = await prisma.brandDossier.findUnique({
          where: { brandId },
          select: {
            summary: true,
            positioning: true,
            toneOfVoice: true,
            targetAudiences: true,
            markets: true,
            products: true,
            services: true,
            visualGuidelines: true,
          },
        });
        return {
          summary: row?.summary?.trim() ?? "",
          positioning: row?.positioning?.trim() ?? "",
          toneOfVoice: row?.toneOfVoice?.trim() ?? "",
          targetAudiences: strings(row?.targetAudiences),
          markets: strings(row?.markets),
          products: strings(row?.products),
          services: strings(row?.services),
          visualGuidelines: strings(row?.visualGuidelines),
        };
      },
      write: async (scope, data) => {
        await prisma.brandDossier.upsert({
          where: { brandId: scope.brandId },
          create: { ...scope, ...data },
          update: data,
        });
      },
    },
    audit: async (entry) => {
      await auditRepo.AuditLogRepository.record({
        workspaceId: entry.workspaceId,
        projectId: entry.projectId,
        brandId: entry.brandId,
        actorType: "USER",
        actorId: entry.actorId,
        action: entry.action,
        entityType: "Project",
        entityId: entry.projectId,
        metadata: entry.metadata,
      });
    },
  };
}
