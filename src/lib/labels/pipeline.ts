import {
  CheckCircle2,
  ClipboardCheck,
  Hammer,
  Lightbulb,
  OctagonAlert,
  Send,
} from "lucide-react";

import type { PipelineStageKey } from "@/lib/pipeline/derive-stage";
import type { EnumMap } from "./types";

export { PIPELINE_STAGE_ORDER } from "@/lib/pipeline/derive-stage";
export type { PipelineStageKey } from "@/lib/pipeline/derive-stage";

export const PIPELINE_STAGE: EnumMap<PipelineStageKey> = {
  fikir: { label: "Fikir", tone: "neutral", icon: Lightbulb },
  uretim: { label: "Üretim", tone: "active", icon: Hammer },
  onay: { label: "Onay", tone: "waiting", icon: ClipboardCheck },
  yayinda: { label: "Yürütme / Yayın", tone: "active", icon: Send },
  tamamlandi: { label: "Tamamlandı", tone: "positive", icon: CheckCircle2 },
  durdu: { label: "Durduruldu", tone: "danger", icon: OctagonAlert },
};

// Short explainer shown under each board column header.
export const PIPELINE_STAGE_HINTS: Record<PipelineStageKey, string> = {
  fikir: "Fikir değerlendiriliyor, henüz üretime alınmadı.",
  uretim: "İçerik veya kreatif üretimi ve görevler yürütülüyor.",
  onay: "Bir onay ya da insan kararı bekleniyor.",
  yayinda: "Sağlayıcıda çalışıyor veya yayına çıkıyor.",
  tamamlandi: "İş tamamlandı.",
  durdu: "Reddedildi, iptal edildi ya da başarısız oldu — dikkat gerekiyor.",
};
