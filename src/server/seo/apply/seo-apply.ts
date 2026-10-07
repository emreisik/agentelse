import "server-only";

import { seoApplyEnabled } from "@/lib/seo/apply/flags";

import { onSeoApplyTaskApproved, syncSeoChangeApprovalState } from "./approval-hook";
import { cleanupSeoApplyForSite } from "./cleanup";
import { proposeSeoChange } from "./propose";
import { runSeoApplyDue } from "./reconcile";
import { undoSeoChange } from "./undo";

// SC-F8 uygulama katmanının tek giriş noktası (docs/website-apply.md). Eylem
// katmanı, onay köprüsü ve tick adımı yalnız bunu çağırır. Statik içe aktarımlar:
// işçi grafiğinde tenant-context, next-auth ya da next/navigation yoktur.

export const SeoApply = {
  propose: proposeSeoChange,
  onTaskApproved: onSeoApplyTaskApproved,
  syncApprovalState: syncSeoChangeApprovalState,
  undo: undoSeoChange,
  // Tick adımı 'seo-apply': bayrak kapalıyken hiçbir veritabanı çağrısı yapılmaz.
  async runDue(limit?: number, now?: Date): Promise<number> {
    if (!seoApplyEnabled()) return 0;
    return runSeoApplyDue(limit, now);
  },
  cleanupForSite: cleanupSeoApplyForSite,
};
