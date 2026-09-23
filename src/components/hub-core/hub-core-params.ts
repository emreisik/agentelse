// HUB CORE's single query-param contract. Replaces the scattered
// `tab=`/`task=`/`plan=`/`idea=`/`audit=`/`card=` params of the old pages
// with ONE schema: `panel` (which orbit node is open), `sub` (that node's
// own sub-tab, if it has one), `entity` (open a record's detail, `kind:id`).

export const PANEL_KEYS = [
  "setup",
  "brand-brain",
  "signals",
  "insights-opportunities",
  "goals",
  "ideas",
  "work",
  "departments",
  "approvals",
  "human-action",
  "settings",
  "library",
] as const;

export type PanelKey = (typeof PANEL_KEYS)[number];

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

const SUB_KEYS_BY_PANEL: Partial<Record<PanelKey, readonly string[]>> = {
  work: WORK_SUB_KEYS,
  settings: SETTINGS_SUB_KEYS,
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
  signal: "signals",
  finding: "signals",
  insight: "insights-opportunities",
  opportunity: "insights-opportunities",
  goal: "goals",
  handoff: "work",
  measurementPlan: "work",
  department: "departments",
  decision: "settings",
  constitution: "brand-brain",
};

// Produces an href that directly opens an entity — the standard usage for
// cross-link chips. The panel is inferred automatically from ENTITY_PANEL;
// `sub` (the panel's first sensible sub-tab, if any) is optional.
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
