import type { EntityRef } from "../hub-core-params";

// Her panel component'inin uyduğu ortak sözleşme — Faz 1'de her panel
// bağımsız yazılabilsin diye panel-shell.tsx bu tipe göre dispatch eder.
export type PanelProps = {
  projectId: string;
  entity: EntityRef | null;
  sub: string | null;
};
