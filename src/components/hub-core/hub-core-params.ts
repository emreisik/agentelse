// HUB CORE'un tek query-param sözleşmesi. Eski sayfalardaki dağınık
// `tab=`/`gorev=`/`plan=`/`fikir=`/`denetim=`/`kart=` param'larının yerini
// TEK şema alır: `panel` (hangi yörünge düğümü açık), `sub` (o düğümün
// kendi alt-sekmesi varsa), `entity` (bir kaydın detayını aç, `kind:id`).

export const PANEL_KEYS = [
  "kurulum",
  "marka-beyni",
  "sinyaller",
  "icgoru-firsat",
  "hedefler",
  "fikirler",
  "isler",
  "departmanlar",
  "onaylar",
  "insan-eylem",
  "ayarlar",
  "kutuphane",
] as const;

export type PanelKey = (typeof PANEL_KEYS)[number];

export const ISLER_SUB_KEYS = [
  "planlar",
  "gorevler",
  "devirler",
  "olcumler",
] as const;
export type IslerSubKey = (typeof ISLER_SUB_KEYS)[number];

export const AYARLAR_SUB_KEYS = [
  "otonomi",
  "kararlar",
  "aktivite",
  "tehlike",
] as const;
export type AyarlarSubKey = (typeof AYARLAR_SUB_KEYS)[number];

const SUB_KEYS_BY_PANEL: Partial<Record<PanelKey, readonly string[]>> = {
  isler: ISLER_SUB_KEYS,
  ayarlar: AYARLAR_SUB_KEYS,
};

// Bir kaydın detayını açan tek birleşik param — `kart=idea:ID` deseninin
// genellenmiş hali. Yeni bir modül eklendiğinde buraya bir satır ekle.
export const ENTITY_KINDS = [
  "idea",
  "workPlan",
  "task",
  "signal",
  "finding",
  "insight",
  "opportunity",
  "goal",
  "handoff",
  "measurementPlan",
  "department",
  "decision",
  "constitution",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];
export type EntityRef = { kind: EntityKind; id: string };

export type HubParams = {
  panel: PanelKey | null;
  sub: string | null;
  entity: EntityRef | null;
};

type RawSearchParams = Record<string, string | string[] | undefined>;

function firstString(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

export function parseHubParams(sp: RawSearchParams): HubParams {
  const panelRaw = firstString(sp.panel);
  const panel = (PANEL_KEYS as readonly string[]).includes(panelRaw ?? "")
    ? (panelRaw as PanelKey)
    : null;

  const subRaw = firstString(sp.sub);
  const allowedSubs = panel ? SUB_KEYS_BY_PANEL[panel] : undefined;
  const sub = allowedSubs && allowedSubs.includes(subRaw ?? "") ? subRaw : null;

  const entityRaw = firstString(sp.entity);
  let entity: EntityRef | null = null;
  if (entityRaw) {
    const separatorIndex = entityRaw.indexOf(":");
    if (separatorIndex > 0) {
      const kind = entityRaw.slice(0, separatorIndex);
      const id = entityRaw.slice(separatorIndex + 1);
      if ((ENTITY_KINDS as readonly string[]).includes(kind) && id) {
        entity = { kind: kind as EntityKind, id };
      }
    }
  }

  return { panel, sub, entity };
}

// Verilen alanları geçerli param'larla birleştirip proje köküne göreli bir
// href üretir. `undefined` geçilen alanlar mevcut değerden korunur,
// `null` geçilenler URL'den temizlenir.
export function buildHubHref(
  projectId: string,
  patch: {
    panel?: PanelKey | null;
    sub?: string | null;
    entity?: EntityRef | null;
  },
  current: HubParams = { panel: null, sub: null, entity: null },
): string {
  const next: HubParams = {
    panel: patch.panel !== undefined ? patch.panel : current.panel,
    sub: patch.sub !== undefined ? patch.sub : current.sub,
    entity: patch.entity !== undefined ? patch.entity : current.entity,
  };

  const query = new URLSearchParams();
  if (next.panel) query.set("panel", next.panel);
  if (next.sub) query.set("sub", next.sub);
  if (next.entity) query.set("entity", `${next.entity.kind}:${next.entity.id}`);

  const qs = query.toString();
  return `/projects/${projectId}${qs ? `?${qs}` : ""}`;
}

export function entityRefToParam(entity: EntityRef): string {
  return `${entity.kind}:${entity.id}`;
}

// Bir kayıt türünü, o kaydı açan panele eşler — cross-link chip'lerin
// hangi paneli+entity'yi açacağını bilmesi için.
export const ENTITY_PANEL: Record<EntityKind, PanelKey> = {
  idea: "fikirler",
  workPlan: "isler",
  task: "isler",
  signal: "sinyaller",
  finding: "sinyaller",
  insight: "icgoru-firsat",
  opportunity: "icgoru-firsat",
  goal: "hedefler",
  handoff: "isler",
  measurementPlan: "isler",
  department: "departmanlar",
  decision: "ayarlar",
  constitution: "marka-beyni",
};

// Bir entity'yi doğrudan açan href üretir — cross-link chip'lerin standart
// kullanımı. Panel otomatik olarak ENTITY_PANEL'den, sub (varsa ilgili
// panelin ilk mantıklı alt-sekmesi) opsiyonel olarak geçilir.
export function entityHref(
  projectId: string,
  entity: EntityRef,
  sub?: string | null,
): string {
  return buildHubHref(projectId, {
    panel: ENTITY_PANEL[entity.kind],
    sub: sub ?? null,
    entity,
  });
}
