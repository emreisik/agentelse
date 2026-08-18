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
  fikir: { label: "Idea", tone: "neutral", icon: Lightbulb },
  uretim: { label: "Production", tone: "active", icon: Hammer },
  onay: { label: "Approval", tone: "waiting", icon: ClipboardCheck },
  yayinda: { label: "Execution / Publish", tone: "active", icon: Send },
  tamamlandi: { label: "Completed", tone: "positive", icon: CheckCircle2 },
  durdu: { label: "Stopped", tone: "danger", icon: OctagonAlert },
};

// Short explainer shown under each board column header.
export const PIPELINE_STAGE_HINTS: Record<PipelineStageKey, string> = {
  fikir: "Idea is being evaluated, not yet in production.",
  uretim: "Content or creative production and tasks are underway.",
  onay: "Waiting on an approval or human decision.",
  yayinda: "Running with the provider or going live.",
  tamamlandi: "Work is complete.",
  durdu: "Rejected, cancelled, or failed — needs attention.",
};
