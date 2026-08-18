import type { EntityRef } from "../hub-core-params";

// The common contract every panel component adheres to — in Phase 1,
// panel-shell.tsx dispatches based on this type so each panel can be written independently.
export type PanelProps = {
  projectId: string;
  entity: EntityRef | null;
  sub: string | null;
};
