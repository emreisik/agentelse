"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { DepartmentKey } from "@prisma/client";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type AttachmentAdapter,
  type CompleteAttachment,
  type PendingAttachment,
  type ThreadMessageLike,
} from "@assistant-ui/react";

import {
  submitChatMessageAction,
  type ChatMessageResult,
} from "@/server/actions/command-actions";
import { Thread } from "@/components/assistant-ui/thread";
import type { IdeaEventCardData } from "@/types/idea-event-card";

export type ChatAttachment = {
  assetId: string;
  filename: string;
  mimeType: string;
};

// Sunucudan gelen kalıcı sohbet turu (Command satırı). source: "SYSTEM"
// pipeline'ın (konsey, iş planı, görev/kreatif tamamlanması) bu fikrin
// thread'ine yazdığı olay mesajıdır — kullanıcı mesajı yoktur, yalnızca
// asistan balonu olarak gösterilir. `card` doluysa (kreatif üretimi) düz
// metin yerine thread.tsx'teki CreativeCard ile render edilir.
export type ChatTurn = {
  commandId: string;
  source: "WEB" | "SYSTEM";
  text: string;
  reply: string | null;
  replyStatus: string | null;
  attachments: ChatAttachment[];
  card?: IdeaEventCardData;
  // Yalnızca TEK bir departmana bağlı olay mesajlarında dolu (görev/kreatif
  // tamamlanması) — sohbette departman renginde bir kenar şeridi olarak
  // gösterilir (bkz. thread.tsx AssistantMessage).
  departmentKey?: DepartmentKey;
  createdAt: string;
};

type LocalAttachment = {
  filename: string;
  mimeType: string;
  previewUrl?: string;
};

// Gönderilmiş ama sunucu listesine henüz düşmemiş yerel tur. Sayfa canlı
// yenilemeyle (LiveRefresh) tazelendiğinde aynı commandId sunucu
// listesinde görünür ve yerel kopya elenir.
type LocalTurn = {
  key: string;
  text: string;
  attachments: LocalAttachment[];
  state: "pending" | "done" | "error";
  reply?: string;
  commandId?: string;
};

type FlatMessage =
  | {
      id: string;
      role: "user";
      text: string;
      attachments: (ChatAttachment | LocalAttachment)[];
    }
  | {
      id: string;
      role: "assistant";
      text: string;
      card?: IdeaEventCardData;
      departmentKey?: DepartmentKey;
      error?: boolean;
    };

const CHAT_ACCEPT =
  "image/png,image/jpeg,image/webp,application/pdf,text/plain,text/csv,text/markdown";

const STATUS_NOTE: Record<string, string> = {
  PLANNED: "Görev oluşturuldu",
  APPROVAL_HANDLED: "Onay işlendi",
  UNCLEAR: "Netleştirme bekleniyor",
  ERROR: "Hata",
};

// assistant-ui'nin composer'ı eklenen dosyayı hemen "gönderilebilir" kabul
// ediyor — gerçek yükleme (Asset kaydı + Gemini gövdesi) sunucu action'ı
// içinde, mesaj gönderiminde oluyor. Bu adaptör sadece File referansını
// mesaja kadar taşır.
class ProjectChatAttachmentAdapter implements AttachmentAdapter {
  accept = CHAT_ACCEPT;

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    return {
      id: crypto.randomUUID(),
      type: file.type.startsWith("image/") ? "image" : "file",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  async remove(): Promise<void> {}

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    return { ...attachment, status: { type: "complete" }, content: [] };
  }
}

function attachmentSrc(
  attachment: ChatAttachment | LocalAttachment,
): string | undefined {
  if ("previewUrl" in attachment && attachment.previewUrl) {
    return attachment.previewUrl;
  }
  if ("assetId" in attachment) return `/api/assets/${attachment.assetId}`;
  return undefined;
}

export function ProjectChat({
  projectId,
  projectName,
  turns,
  ideaId,
}: {
  projectId: string;
  projectName: string;
  turns: ChatTurn[];
  // Verildiğinde bu sohbet bir fikrin thread'idir: gönderilen mesajlar o
  // fikre etiketlenir ve LLM bağlamı bu fikrin geçmişiyle (kullanıcı +
  // pipeline olayları) sınırlanır (bkz. ChatService.turn ideaId).
  ideaId?: string;
}) {
  const [localTurns, setLocalTurns] = React.useState<LocalTurn[]>([]);
  const [isSending, startTransition] = React.useTransition();
  const attachmentAdapter = React.useMemo(
    () => new ProjectChatAttachmentAdapter(),
    [],
  );

  // Sunucu listesine düşen turların yerel kopyalarını ele.
  const serverIds = React.useMemo(
    () => new Set(turns.map((turn) => turn.commandId)),
    [turns],
  );
  const visibleLocal = localTurns.filter(
    (turn) => !turn.commandId || !serverIds.has(turn.commandId),
  );

  const messages = React.useMemo<FlatMessage[]>(() => {
    const out: FlatMessage[] = [];
    for (const turn of turns) {
      if (turn.source === "SYSTEM") {
        // Pipeline olayı: kullanıcı balonu yok, sadece asistan notu — kart
        // verisi varsa (kreatif üretimi) düz metin yerine CreativeCard
        // gösterilir (bkz. convertMessage).
        if (turn.reply) {
          out.push({
            id: `${turn.commandId}-a`,
            role: "assistant",
            text: turn.reply,
            card: turn.card,
            departmentKey: turn.departmentKey,
          });
        }
        continue;
      }
      out.push({
        id: `${turn.commandId}-u`,
        role: "user",
        text: turn.text,
        attachments: turn.attachments,
      });
      if (turn.reply) {
        const note = turn.replyStatus
          ? STATUS_NOTE[turn.replyStatus]
          : undefined;
        out.push({
          id: `${turn.commandId}-a`,
          role: "assistant",
          text: note ? `${turn.reply}\n\n*${note}*` : turn.reply,
          // "Görev oluşturuldu" notuyla birlikte hangi ekibe gittiği artık
          // düz metin DEĞİL, thread.tsx'in departmentKey'den render ettiği
          // gerçek DepartmentBadge (departman rengi+ikonu) ile gösterilir.
          departmentKey: turn.departmentKey,
        });
      }
    }
    for (const turn of visibleLocal) {
      out.push({
        id: `${turn.key}-u`,
        role: "user",
        text: turn.text,
        attachments: turn.attachments,
      });
      if (turn.state === "pending") {
        out.push({
          id: `${turn.key}-a`,
          role: "assistant",
          text: "Düşünüyor…",
        });
      } else if (turn.reply) {
        out.push({
          id: `${turn.key}-a`,
          role: "assistant",
          text: turn.reply,
          error: turn.state === "error",
        });
      }
    }
    return out;
  }, [turns, visibleLocal]);

  const convertMessage = React.useCallback(
    (message: FlatMessage): ThreadMessageLike => {
      if (message.role === "user") {
        return {
          role: "user",
          content: message.text,
          attachments: message.attachments.map((attachment, index) => {
            const isImage = attachment.mimeType.startsWith("image/");
            const src = attachmentSrc(attachment);
            return {
              id: `${message.id}-att-${index}`,
              type: isImage ? "image" : "file",
              name: attachment.filename,
              contentType: attachment.mimeType,
              status: { type: "complete" },
              content: isImage && src ? [{ type: "image", image: src }] : [],
            };
          }),
        };
      }
      // Kart verisi varsa (kreatif üretimi — yükleniyor/hazır/başarısız)
      // düz metin yerine metadata.custom.card üzerinden thread.tsx'teki
      // CreativeCard render edilir (bkz. AssistantMessage); content boş
      // bırakılır ki aynı bilgi iki kez (hem düz metin hem kart) görünmesin.
      // departmentKey (kart olsun olmasın) aynı metadata.custom üzerinden
      // taşınır — thread.tsx bunu bir kenar şeridi olarak render eder.
      if (message.card || message.departmentKey) {
        return {
          role: "assistant",
          content: message.card ? [] : message.text,
          metadata: {
            custom: {
              card: message.card,
              departmentKey: message.departmentKey,
            },
          },
          status: message.error
            ? { type: "incomplete", reason: "error" }
            : undefined,
        };
      }

      return {
        role: "assistant",
        content: message.text,
        status: message.error
          ? { type: "incomplete", reason: "error" }
          : undefined,
      };
    },
    [],
  );

  const onNew = React.useCallback(
    async (message: AppendMessage) => {
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      const files = (message.attachments ?? [])
        .map((attachment) => attachment.file)
        .filter((file): file is File => Boolean(file));

      if (!text && files.length === 0) return;

      const key = `local-${crypto.randomUUID()}`;
      setLocalTurns((current) => [
        ...current,
        {
          key,
          text: text || "(dosya gönderildi)",
          attachments: files.map((file) => ({
            filename: file.name,
            mimeType: file.type,
            previewUrl: file.type.startsWith("image/")
              ? URL.createObjectURL(file)
              : undefined,
          })),
          state: "pending",
        },
      ]);

      await new Promise<void>((resolve) => {
        startTransition(async () => {
          const formData = new FormData();
          formData.set("projectId", projectId);
          if (ideaId) formData.set("ideaId", ideaId);
          formData.set("text", text);
          for (const file of files) formData.append("files", file);

          let result: ChatMessageResult;
          try {
            result = await submitChatMessageAction(formData);
          } catch (error) {
            result = {
              ok: false,
              message:
                error instanceof Error ? error.message : "Mesaj gönderilemedi",
            };
          }

          setLocalTurns((current) =>
            current.map((turn) =>
              turn.key === key
                ? result.ok
                  ? {
                      ...turn,
                      state: "done",
                      reply: result.reply,
                      commandId: result.commandId,
                    }
                  : { ...turn, state: "error", reply: result.message }
                : turn,
            ),
          );
          if (!result.ok) toast.error(result.message);
          resolve();
        });
      });
    },
    [projectId, ideaId],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning: isSending,
    onNew,
    adapters: { attachments: attachmentAdapter },
  });

  const Welcome = React.useCallback(
    () => (
      <div className="mb-6 flex flex-col items-center gap-3 px-4 text-center">
        <span className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground">
          <Sparkles className="size-4" />
        </span>
        <p className="max-w-sm text-sm text-muted-foreground">
          Merhaba! {projectName} için buradayım. Bir içerik isteyin, soru sorun
          ya da görsel/dosya ekleyerek talimat verin — örneğin &quot;bu görseli
          kullanarak Instagram postu hazırla&quot;.
        </p>
      </div>
    ),
    [projectName],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread components={{ Welcome }} />
    </AssistantRuntimeProvider>
  );
}
