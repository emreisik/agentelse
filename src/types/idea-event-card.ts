import { type CreativeCardData, isCreativeCardData } from "./creative-card";

// Bir fikrin sohbetindeki HER pipeline olayının (köken sinyali/bulgusu,
// içgörü/fırsat, fikir doğumu, konsey kararı, iş planı, görev sonucu,
// kreatif üretimi) temsili — "altın kural": hepsi aynı kart formatında,
// Command.parsedIntent alanına `{ card: IdeaEventCardData }` olarak yazılır
// (bkz. IdeaChatRepository) ve sohbet ekranında (project-chat.tsx +
// thread.tsx) düz metin yerine IdeaEventCard bileşeniyle render edilir.
// Uzun gövdeler (konsey gerekçesi, görev çıktı metni, bulgu/içgörü
// açıklaması) varsayılan kapalı, tıklayınca açılan bir alanda gösterilir.
export type IdeaEventCardData =
  | { kind: "signal"; title: string; summary?: string }
  | { kind: "finding"; title: string; statement: string }
  | {
      kind: "insight-opportunity";
      title: string;
      summary?: string;
      description?: string;
    }
  | { kind: "idea"; title: string; description: string }
  | {
      kind: "council";
      verdict: string;
      notes: { council: string; verdict: string; rationale?: string }[];
    }
  | {
      kind: "work-plan";
      title: string;
      nodes: { department: string; request: string }[];
    }
  | {
      kind: "task-running";
      taskId: string;
      title: string;
      department?: string;
    }
  | {
      kind: "task-result";
      taskId: string;
      title: string;
      department?: string;
      status: "COMPLETED" | "FAILED" | "CANCELLED";
      resultText?: string;
    }
  | {
      kind: "approval-request";
      approvalId: string;
      taskId: string;
      title: string;
      department?: string;
      riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    }
  | {
      kind: "approval-decision";
      title: string;
      entityType: "Task" | "Creative";
      decision: "APPROVED" | "REJECTED";
      note?: string;
    }
  | {
      kind: "publish-result";
      taskId: string;
      platform: string;
      title: string;
      status: "COMPLETED" | "FAILED";
      postId?: string;
      permalink?: string;
      errorMessage?: string;
    }
  | CreativeCardData;

const EVENT_KINDS = new Set([
  "signal",
  "finding",
  "insight-opportunity",
  "idea",
  "council",
  "work-plan",
  "task-running",
  "task-result",
  "approval-request",
  "approval-decision",
  "publish-result",
]);

export function isIdeaEventCardData(
  value: unknown,
): value is IdeaEventCardData {
  if (isCreativeCardData(value)) return true;
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && EVENT_KINDS.has(kind);
}
