import type { CreativeStatus } from "@prisma/client";

// Turkish status words for the Brand Workspace surfaces (outputs panel,
// calendar panel, output preview dialog, in-chat creative card) —
// deliberately NOT touching the shared CREATIVE_STATUS map in lib/labels
// (used across many still-English legacy screens: /creatives detail,
// StatusBadge, etc.), same reasoning as dayLabel in lib/dates.ts.
//
// Split into its own client-safe module (no "server-only") rather than
// living in workspace-right-panel-data.ts: several "use client" files
// (output-preview-dialog.tsx, calendar-panel.tsx, creative-card.tsx) need
// this as a real runtime value, and a bundler can't elide a value import
// the way it elides `import type` — pulling in workspace-right-panel-data.ts
// (which starts with `import "server-only"`) from a client component
// fails the build ("You're importing a module that depends on
// 'server-only' ... in the Pages Router" is Next's misleading message for
// this exact client/server boundary violation).
export const WORKSPACE_STATUS_LABEL_TR: Record<CreativeStatus, string> = {
  DRAFT: "Taslak",
  IN_REVIEW: "Onay bekliyor",
  APPROVED: "Onaylandı",
  REJECTED: "Reddedildi",
  PUBLISHED: "Yayınlandı",
  ARCHIVED: "Arşivlendi",
};
