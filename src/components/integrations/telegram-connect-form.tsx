"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plug, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { connectTelegramAction } from "@/server/actions/telegram-actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";

type State = { ok: true } | { ok: false; message: string } | null;
type Draft = { botToken: string; chatId: string; allowedApproverIds: string };

const EMPTY_DRAFT: Draft = { botToken: "", chatId: "", allowedApproverIds: "" };

// Bu formun taslağı sessionStorage'a yazılır (proje başına ayrı anahtar) —
// bu oturumda kurulum sırasında birden fazla kez dev sunucusu yeniden
// başlatılıp sayfa yenilendi ve her seferinde uzun bot token'ı yeniden
// yazmak gerekti. sessionStorage sekme kapanınca kendiliğinden temizlenir
// (localStorage değil) ve bağlantı başarılı olduğunda da hemen siliniyor —
// token gerekenden uzun süre tarayıcıda durmasın diye.
function draftKey(projectId: string): string {
  return `telegram-connect-draft:${projectId}`;
}

function readDraft(projectId: string): Draft {
  try {
    const raw = window.sessionStorage.getItem(draftKey(projectId));
    if (!raw) return EMPTY_DRAFT;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "botToken" in parsed &&
      "chatId" in parsed &&
      typeof (parsed as Draft).botToken === "string" &&
      typeof (parsed as Draft).chatId === "string"
    ) {
      const draft = parsed as Partial<Draft>;
      return {
        botToken: draft.botToken ?? "",
        chatId: draft.chatId ?? "",
        allowedApproverIds:
          typeof draft.allowedApproverIds === "string"
            ? draft.allowedApproverIds
            : "",
      };
    }
  } catch {
    // sessionStorage erişilemiyor olabilir (gizli mod vb.) — sessizce yok say.
  }
  return EMPTY_DRAFT;
}

function writeDraft(projectId: string, draft: Draft) {
  try {
    window.sessionStorage.setItem(draftKey(projectId), JSON.stringify(draft));
  } catch {
    // yazılamıyorsa taslak kaydı olmadan devam — kritik değil.
  }
}

function clearDraft(projectId: string) {
  try {
    window.sessionStorage.removeItem(draftKey(projectId));
  } catch {
    // yoksay
  }
}

// Bot token'ı, sohbet ID'sini ve izinli onaycı listesini kontrollü input
// olarak tutuyoruz — başarısız bir denemeden sonra (ör. yanlış chat id)
// veya sayfa yenilemesinden sonra kullanıcı uzun token'ı yeniden yazmak
// zorunda kalmasın, sadece hatalı alanı düzeltip tekrar denesin.
export function TelegramConnectForm({
  projectId,
  hasExistingConnection,
}: {
  projectId: string;
  hasExistingConnection: boolean;
}) {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [allowedApproverIds, setAllowedApproverIds] = useState("");
  const router = useRouter();

  // Sunucu tarafı render ile eşleşme (hydration) sorunu yaşamamak için
  // sessionStorage'dan okuma mount sonrası bir efekte bırakılıyor — lazy
  // useState initializer'ında window'a erişmek SSR/istemci render'ları
  // arasında uyuşmazlık yaratırdı. Bu, React'in kendi dokümantasyonunun
  // da örneklediği meşru bir "dış sistemle (tarayıcı depolaması) mount'ta
  // senkronize ol" efekti — kademeli render riski yaratmıyor çünkü en
  // fazla bir kez, sadece mount'ta (ya da projectId değişince) çalışıyor.
  useEffect(() => {
    const draft = readDraft(projectId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (draft.botToken) setBotToken(draft.botToken);
    if (draft.chatId) setChatId(draft.chatId);
    if (draft.allowedApproverIds)
      setAllowedApproverIds(draft.allowedApproverIds);
  }, [projectId]);

  const updateBotToken = (value: string) => {
    setBotToken(value);
    writeDraft(projectId, { botToken: value, chatId, allowedApproverIds });
  };
  const updateChatId = (value: string) => {
    setChatId(value);
    writeDraft(projectId, { botToken, chatId: value, allowedApproverIds });
  };
  const updateAllowedApproverIds = (value: string) => {
    setAllowedApproverIds(value);
    writeDraft(projectId, { botToken, chatId, allowedApproverIds: value });
  };

  const [state, formAction] = useActionState(
    async (_prev: State, formData: FormData): Promise<State> => {
      const result = await connectTelegramAction(formData);
      if (result.ok) {
        toast.success("Telegram bağlandı");
        setBotToken("");
        setChatId("");
        setAllowedApproverIds("");
        clearDraft(projectId);
        router.refresh();
      } else {
        toast.error(result.message);
      }
      return result;
    },
    null,
  );

  const failed = state !== null && !state.ok;

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="space-y-1.5">
        <label className="text-xs font-medium">Bot Token</label>
        <Input
          name="botToken"
          type="password"
          placeholder="123456:ABC-DEF..."
          className="h-8 text-xs"
          value={botToken}
          onChange={(e) => updateBotToken(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium">
          Sohbet ID veya @kullaniciadi
        </label>
        <Input
          name="chatId"
          placeholder="@kanaladi ya da -1001234567890"
          className="h-8 text-xs"
          value={chatId}
          onChange={(e) => updateChatId(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium">
          Onay yetkisi olan Telegram kullanıcı ID&apos;leri (opsiyonel)
        </label>
        <Input
          name="allowedApproverIds"
          placeholder="123456789, 987654321"
          className="h-8 text-xs"
          value={allowedApproverIds}
          onChange={(e) => updateAllowedApproverIds(e.target.value)}
        />
      </div>
      {failed ? (
        <p className="text-[11px] text-destructive">{state.message}</p>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        Botu @BotFather&apos;dan oluşturun, token&apos;ı buraya girin. Herkese
        açık kanal için @kullaniciadi yazabilirsiniz; özel grup/kanal için
        sayısal sohbet ID&apos;sini @userinfobot gibi bir yardımcı botla
        bulabilirsiniz. Botu hedef kanala/gruba yönetici olarak eklemeyi
        unutmayın.
      </p>
      <p className="text-[10px] text-muted-foreground/70">
        Onay isteklerinde &quot;Onayla&quot;/&quot;Reddet&quot; butonlarını
        kimin kullanabileceğini sınırlar — kendi ID&apos;nizi @userinfobot ile
        bulabilirsiniz. Boş bırakılırsa onay mesajları sadece bilgilendirme
        amaçlı gönderilir, buton eklenmez.
      </p>
      <p className="text-[10px] text-muted-foreground/70">
        Girdikleriniz bu sekme açıkken tarayıcınızda tutulur (sayfa yenilense
        bile kaybolmaz) — bağlantı başarılı olduğunda otomatik temizlenir.
      </p>
      <SubmitButton size="xs">
        {failed ? (
          <RefreshCw className="size-3" />
        ) : (
          <Plug className="size-3" />
        )}
        {failed
          ? "Tekrar Dene"
          : hasExistingConnection
            ? "Yeniden Bağla"
            : "Bağlan"}
      </SubmitButton>
    </form>
  );
}
