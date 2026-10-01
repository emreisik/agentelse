// HUB CORE's single query-param contract. Replaces the scattered
// `tab=`/`task=`/`plan=`/`idea=`/`audit=`/`card=` params of the old pages
// with ONE schema: `panel` (which orbit node is open), `sub` (that node's
// own sub-tab, if it has one), `entity` (open a record's detail, `kind:id`).

export const PANEL_KEYS = [
  "setup",
  "brand-brain",
  "ideas",
  "work",
  "departments",
  "human-action",
  "settings",
  "library",
] as const;

export type PanelKey = (typeof PANEL_KEYS)[number];

// Panels with no primary sidebar entry of their own — the header's "Advanced"
// menu (project-tools-menu.tsx) is where they live (the sidebar lists only
// Settings among them, as one line at the bottom). Single source of truth for
// that grouping so the sidebar and the menu can't drift apart. (Signals,
// Insights & Opportunities and Goals are tabs of Brand Brain now; pending
// decisions have no panel: they are cards in the Agency Desk chat.)
export const ADVANCED_PANEL_KEYS = [
  "setup",
  "departments",
  "human-action",
  "settings",
] as const satisfies readonly PanelKey[];

export function isAdvancedPanel(panel: PanelKey): boolean {
  return (ADVANCED_PANEL_KEYS as readonly PanelKey[]).includes(panel);
}

export const WORK_SUB_KEYS = [
  "plans",
  "tasks",
  "cycles",
  "measurements",
] as const;
export type WorkSubKey = (typeof WORK_SUB_KEYS)[number];

export const SETTINGS_SUB_KEYS = [
  "autonomy",
  "publishing",
  "decisions",
  "activity",
  "risk",
] as const;
export type SettingsSubKey = (typeof SETTINGS_SUB_KEYS)[number];

export const BRAND_BRAIN_SUB_KEYS = [
  "assets",
  "rules",
  "visual-identity",
  "constitution",
  "goals",
  "strategy",
  "decisions",
  "intelligence",
  "evidence",
  "learnings",
] as const;
export type BrandBrainSubKey = (typeof BRAND_BRAIN_SUB_KEYS)[number];

const SUB_KEYS_BY_PANEL: Partial<Record<PanelKey, readonly string[]>> = {
  work: WORK_SUB_KEYS,
  settings: SETTINGS_SUB_KEYS,
  "brand-brain": BRAND_BRAIN_SUB_KEYS,
};

// The single unified param that opens a record's detail — the generalized
// form of the old `card=idea:ID` pattern. Add a line here when a new module
// is introduced.
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

// Panel and sub-tab names that used to exist (the English panels that became
// Brand Brain tabs, and the Turkish names of the first HUB CORE), mapped to
// where their content lives now. A bookmark, an old email or a saved link keeps
// landing on the right screen instead of the chat. `sub` maps only when the
// old panel had sub-tabs of its own.
const LEGACY_PANELS: Record<
  string,
  { panel: PanelKey; sub?: string; subs?: Record<string, string> }
> = {
  signals: { panel: "brand-brain", sub: "intelligence" },
  "insights-opportunities": { panel: "brand-brain", sub: "intelligence" },
  goals: { panel: "brand-brain", sub: "goals" },
  sinyaller: { panel: "brand-brain", sub: "intelligence" },
  "icgoru-firsat": { panel: "brand-brain", sub: "intelligence" },
  hedefler: { panel: "brand-brain", sub: "goals" },
  "marka-beyni": { panel: "brand-brain" },
  fikirler: { panel: "ideas" },
  isler: {
    panel: "work",
    subs: {
      planlar: "plans",
      gorevler: "tasks",
      devirler: "cycles",
      olcumler: "measurements",
    },
  },
  departmanlar: { panel: "departments" },
  ayarlar: {
    panel: "settings",
    subs: {
      otonomi: "autonomy",
      kararlar: "decisions",
      aktivite: "activity",
      tehlike: "risk",
    },
  },
  kurulum: { panel: "setup" },
};

// Rewrites an old `?panel=`/`?sub=` pair to the current one; anything that is
// not an old name is returned as it came.
export function normalizeLegacyHubParams(sp: RawSearchParams): RawSearchParams {
  const panelRaw = firstString(sp.panel);
  const legacy = panelRaw ? LEGACY_PANELS[panelRaw] : undefined;
  if (!legacy) return sp;
  const subRaw = firstString(sp.sub);
  return {
    ...sp,
    panel: legacy.panel,
    sub: legacy.sub ?? (subRaw ? legacy.subs?.[subRaw] ?? subRaw : undefined),
  };
}

export function parseHubParams(rawParams: RawSearchParams): HubParams {
  const sp = normalizeLegacyHubParams(rawParams);
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

// Merges the given fields with the current params and produces an href
// relative to the project root. Fields passed as `undefined` are kept from
// the current value; fields passed as `null` are cleared from the URL.
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

// Maps a record kind to the panel that opens it — so cross-link chips know
// which panel+entity to open.
export const ENTITY_PANEL: Record<EntityKind, PanelKey> = {
  idea: "ideas",
  workPlan: "work",
  task: "work",
  signal: "brand-brain",
  finding: "brand-brain",
  insight: "brand-brain",
  opportunity: "brand-brain",
  goal: "brand-brain",
  handoff: "work",
  measurementPlan: "work",
  department: "departments",
  decision: "settings",
  constitution: "brand-brain",
};

// The sub-tab of that panel which owns the record, for the kinds whose panel
// has tabs: Brand Brain keeps intelligence (finding, insight, opportunity,
// signal), goals and the constitution each in their own tab.
export const ENTITY_SUB: Partial<Record<EntityKind, BrandBrainSubKey>> = {
  signal: "intelligence",
  finding: "intelligence",
  insight: "intelligence",
  opportunity: "intelligence",
  goal: "goals",
  constitution: "constitution",
};

// Produces an href that directly opens an entity — the standard usage for
// cross-link chips. The panel and its sub-tab are inferred from ENTITY_PANEL /
// ENTITY_SUB; an explicit `sub` wins.
export function entityHref(
  projectId: string,
  entity: EntityRef,
  sub?: string | null,
): string {
  return buildHubHref(projectId, {
    panel: ENTITY_PANEL[entity.kind],
    sub: sub ?? ENTITY_SUB[entity.kind] ?? null,
    entity,
  });
}

// Where an old standalone route (/zeka, /isler, /ayarlar...) sends its
// visitors: a record opens where it lives now (entityHref), otherwise the old
// panel and sub-tab names map to the current ones (LEGACY_PANELS). An unknown
// name lands on the project root instead of breaking.
export function legacyRouteHref(
  projectId: string,
  legacyPanel: string,
  options: { sub?: string | null; entity?: EntityRef | null } = {},
): string {
  if (options.entity) return entityHref(projectId, options.entity);
  const { panel, sub } = parseHubParams({
    panel: legacyPanel,
    sub: options.sub ?? undefined,
  });
  return buildHubHref(projectId, { panel, sub });
}
