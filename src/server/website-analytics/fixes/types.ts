import "server-only";

import type {
  GaFixErrorCode,
  GaFixKind,
  GaFixRefusal,
  GaFixSource,
  GaFixStatus,
} from "@/lib/website-analytics/fixes/types";
import type { GaAdminWriter } from "@/server/integrations/google-analytics/admin-write";

// GA-F7 motorunun (propose, apply, undo, reconcile) paylaştığı sunucu tipleri.
// P4a sahibidir; P4b ve P4c buradan içe aktarır.

// Testlerin ve mock modunun enjekte ettiği bağımlılıklar. Hepsi isteğe bağlı:
// verilmezse gerçek davranış (resolveGaFixDeps) kullanılır.
export type GaFixDeps = {
  writer?: GaAdminWriter;
  now?: Date;
  mock?: boolean;
  tokenFor?: (credential: {
    id: string;
    encryptedSecret: string;
  }) => Promise<string>;
};

export type ProposeInput = {
  projectId: string;
  kind: GaFixKind;
  // Doğrulanmamış kullanıcı girdisi; validateFixParams'tan geçer.
  raw?: unknown;
  source: GaFixSource;
  actor: { type: "USER"; userId: string } | { type: "SYSTEM" };
  // Aynı (bağ, tür, konu) için tek açık değişikliği belirleyen konu anahtarı.
  dedupeSubject?: string;
  now?: Date;
};

export type ProposeResult =
  | {
      ok: true;
      changeId: string;
      status: GaFixStatus;
      created: boolean;
      approvalId: string | null;
    }
  | { ok: false; code: GaFixRefusal; message: string };

export type GaFixAuditAction =
  | "ga_config_change.proposed"
  | "ga_config_change.approved"
  | "ga_config_change.applied"
  | "ga_config_change.verified"
  | "ga_config_change.failed"
  | "ga_config_change.undone"
  | "ga_config_change.expired"
  | "ga_config_change.rejected";

export type GaFixAuditMeta = {
  changeId: string;
  kind: GaFixKind;
  source?: GaFixSource;
  code?: GaFixErrorCode;
};
