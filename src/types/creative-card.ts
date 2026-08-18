// Bir kreatif/görsel üretim olayının fikir sohbetindeki temsili. Command.
// parsedIntent alanına `{ card: CreativeCardData }` olarak yazılır (bkz.
// IdeaChatRepository) ve sohbet ekranında (project-chat.tsx + thread.tsx)
// düz metin yerine özel bir kart bileşeniyle render edilir. Aynı taskId için
// önce "creative-loading" yazılır, iş bitince AYNI satır "creative-ready"
// ya da "creative-failed"e güncellenir (ChatGPT'deki üretim sırasında
// gösterilen yükleniyor → sonuç geçişiyle aynı mantık).
export type CreativeCardData =
  | {
      kind: "creative-loading";
      taskId: string;
      title: string;
    }
  | {
      kind: "creative-ready";
      taskId: string;
      title: string;
      creativeId: string;
      assetId?: string;
      mimeType?: string;
      caption?: string;
      copy?: string;
      status: string;
      // status "IN_REVIEW" iken sohbette doğrudan Onayla/Reddet düğmelerini
      // göstermek için — bkz. CreativeCard, ApprovalRepository.create'in
      // döndürdüğü Approval.id (execution-service.ts materializeCreativeFromResult).
      approvalId?: string;
    }
  | {
      kind: "creative-failed";
      taskId: string;
      title: string;
      message?: string;
    }
  | {
      // Kreatif onaylandıktan sonra sohbete düşen ayrı bir soru turu —
      // "Sosyal Hesaplarda Paylaş" bölümünün (creative-ready kartındaki)
      // aynısını içerir, ama gözden kaçmasın diye kendi satırında (bkz.
      // approval-decisions.ts).
      kind: "publish-prompt";
      creativeId: string;
      title: string;
    };

export function isCreativeCardData(value: unknown): value is CreativeCardData {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "creative-loading" ||
    kind === "creative-ready" ||
    kind === "creative-failed" ||
    kind === "publish-prompt"
  );
}
