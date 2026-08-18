// Static relation table derived from the schema's actual foreign-key
// chain — the "feeds / fed by" breadcrumb badges shown at the top when a
// panel opens are read from here. Data, not code: adding a new module
// only requires adding one line.

import type { PanelKey } from "./hub-core-params";

export type LineageRelation = "feeds" | "fedBy" | "relatesTo" | "governs";

export type LineageEdge = { panel: PanelKey; relation: LineageRelation };

export const PANEL_LABEL: Record<PanelKey, string> = {
  setup: "Setup",
  "brand-brain": "Brand Brain",
  signals: "Signals",
  "insights-opportunities": "Insights & Opportunities",
  goals: "Goals",
  ideas: "Ideas",
  work: "Work",
  departments: "Departments",
  approvals: "Approval Center",
  "human-action": "Human Action Center",
  settings: "Settings",
  library: "Library",
};

export const RELATION_LABEL: Record<LineageRelation, string> = {
  feeds: "Feeds",
  fedBy: "Fed by",
  relatesTo: "Related",
  governs: "Governs",
};

// Outgoing/incoming relations for each panel. Symmetric relations
// (feeds/fedBy) are deliberately defined again on both ends so each panel
// can be read from its own perspective.
export const LINEAGE: Record<PanelKey, LineageEdge[]> = {
  setup: [],
  "brand-brain": [{ panel: "signals", relation: "feeds" }],
  signals: [
    { panel: "brand-brain", relation: "fedBy" },
    { panel: "insights-opportunities", relation: "feeds" },
  ],
  "insights-opportunities": [
    { panel: "signals", relation: "fedBy" },
    { panel: "goals", relation: "feeds" },
    { panel: "ideas", relation: "feeds" },
  ],
  goals: [{ panel: "insights-opportunities", relation: "fedBy" }],
  ideas: [
    { panel: "insights-opportunities", relation: "fedBy" },
    { panel: "work", relation: "feeds" },
  ],
  work: [
    { panel: "ideas", relation: "fedBy" },
    { panel: "departments", relation: "relatesTo" },
    { panel: "approvals", relation: "feeds" },
  ],
  departments: [{ panel: "work", relation: "relatesTo" }],
  approvals: [{ panel: "work", relation: "fedBy" }],
  "human-action": [{ panel: "work", relation: "relatesTo" }],
  settings: [],
  library: [],
};
