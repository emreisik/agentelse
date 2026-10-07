import "server-only";

import type { CmsSite } from "@prisma/client";

import type {
  SeoApplyRefusal,
  SeoChangeStatus,
} from "@/lib/seo/apply/types";
import type { WordPressClient } from "@/server/integrations/wordpress/client";

// SC-F8 motorunun (öneri, onay köprüsü, uygulama, geri alma, uzlaştırma)
// paylaştığı sunucu tipleri. P4a sahibidir; P4b ve P6 buradan içe aktarır.

// Testlerin ve mock modunun enjekte ettiği bağımlılıklar. Hepsi isteğe bağlı:
// verilmezse gerçek davranış (resolveApplyDeps) kullanılır.
export type SeoApplyDeps = {
  now?: Date;
  mock?: boolean;
  client?: WordPressClient;
  clientFor?: (site: CmsSite) => Promise<WordPressClient | null>;
  sleep?: (ms: number) => Promise<void>;
};

export type ProposeSeoChangeInput =
  | {
      projectId: string;
      userId: string;
      kind: "PUBLISH_ARTICLE";
      creativeId: string;
    }
  | {
      projectId: string;
      userId: string;
      kind: "PUBLISH_LIVE";
      draftChangeId: string;
    }
  | {
      projectId: string;
      userId: string;
      kind: "TITLE_META";
      url: string;
      title?: string | null;
      metaDescription?: string | null;
      actionId?: string | null;
    }
  | {
      projectId: string;
      userId: string;
      kind: "INTERNAL_LINKS";
      url: string;
      links: { toUrl: string; anchor: string }[];
      actionId?: string | null;
    };

export type ProposeSeoChangeResult =
  | {
      ok: true;
      changeId: string;
      status: SeoChangeStatus;
      created: boolean;
      approvalId: string | null;
      preview: { label: string; value: string }[];
    }
  | {
      ok: false;
      code: SeoApplyRefusal;
      message: string;
      existingChangeId?: string | null;
    };

export type ApplyState =
  | "verified"
  | "noop"
  | "failed"
  | "retry"
  | "busy"
  | "gone"
  | "skipped"
  | "waiting";
