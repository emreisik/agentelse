import type {
  GaCheckKey,
} from "@/lib/website-analytics/health/types";
import type {
  GaFixErrorCode,
  GaFixKind,
  GaFixSource,
  GaFixStatus,
} from "./types";

// GA-F7 arayüz tipleri (yalnız tip). Sunucu okuyucusu (read.ts) üretir,
// panel ve düğme tüketir.

export type GaFixOffer = {
  id: string;
  kind: GaFixKind;
  checkKey: GaCheckKey | null;
  title: string;
  description: string;
  buttonLabel: "Fix it for me (needs approval)";
  field: {
    name: "eventName";
    label: string;
    options: { value: string; label: string }[];
  } | null;
  state: "available" | "pending" | "needs_access" | "done";
  changeId: string | null;
};

// PROPOSED satırlarda durum ve etiket Approval satırından türetilir: sohbette
// verilen ret kararı hemen 'Rejected' gösterir.
export type GaFixChangeView = {
  id: string;
  kind: GaFixKind;
  title: string;
  status: GaFixStatus;
  statusLabel: string;
  source: GaFixSource;
  createdAt: string;
  resolvedAt: string | null;
  expiresAt: string | null;
  approvalId: string | null;
  canDecide: boolean;
  canUndo: boolean;
  undoWarning: string | null;
  noop: boolean;
  switchedOff: boolean;
  error: { code: GaFixErrorCode; message: string } | null;
};

export type GaOutsideChangeView = {
  alertId: string;
  kind: "KEY_EVENT_REMOVED" | "RETENTION_SHORTENED";
  title: string;
  detail: string | null;
  lastSeenAt: string;
};

export type GaFixesView = {
  editAccess: "granted" | "not_granted";
  canManage: boolean;
  alphaEnabled: boolean;
  canMuteOutside: boolean;
  upgradeHref: string;
  changes: GaFixChangeView[];
  outside: GaOutsideChangeView[];
  offers: GaFixOffer[];
  annotationDefaultDay: string;
};

export type GaFixCounters = {
  linksWithEditAccess: number;
  pendingApprovals: number;
  last30d: {
    proposed: number;
    verified: number;
    failed: number;
    undone: number;
    rejected: number;
    expired: number;
  };
  failedByCode: Record<string, number>;
  watch: { links: number; lastRunMinutesAgo: number | null; errors: number };
  outsideAlertsOpen: number;
  alphaEnabled: boolean;
};
