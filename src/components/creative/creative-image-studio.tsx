"use client";

import { useActionState, useState } from "react";
import { ImagePlus, Ratio, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";

import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import { generateRealCreativeImageAction } from "@/server/actions/creative-actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Textarea } from "@/components/ui/textarea";
import type { SocialPlatform } from "@prisma/client";

type State = { ok: true } | { ok: false; message: string } | null;

// Kreatif görselini yeniden üretmek veya mevcut görseli talimatla
// düzenlemek için. İki mod aynı formu paylaşır; fark, gönderilen `mode`
// alanı: "edit" mevcut görseli modele girdi olarak verir ve kompozisyonu
// koruyarak değiştirir, "new" sıfırdan üretir.
export function CreativeImageStudio({
  creativeId,
  hasImage,
  platform,
}: {
  creativeId: string;
  hasImage: boolean;
  platform?: SocialPlatform | null;
}) {
  const format = getCreativePlatformFormat(platform);
  const [instruction, setInstruction] = useState("");

  const [, formAction] = useActionState(
    async (_prev: State, form: FormData) => {
      const result = await generateRealCreativeImageAction(form);
      if (result.ok) {
        toast.success(
          form.get("mode") === "edit"
            ? "Görsel talimata göre düzenlendi"
            : "Yeni görsel üretildi",
        );
        setInstruction("");
      } else {
        toast.error(result.message);
      }
      return result as State;
    },
    null,
  );

  return (
    <form
      action={formAction}
      className="space-y-2 rounded-xl p-3 ring-1 ring-foreground/10"
    >
      <input type="hidden" name="creativeId" value={creativeId} />

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
            <Wand2 className="size-4" />
          </span>
          <p className="text-sm font-medium">Görsel stüdyosu</p>
        </div>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Ratio className="size-3" />
          {format.label} · {format.aspectRatio}
        </span>
      </div>

      <Textarea
        name="instruction"
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        rows={3}
        placeholder={
          hasImage
            ? "Ne değişsin? Örnek: arka planı sadeleştir, ürünü büyüt, marka mavisini öne çıkar, üstteki yazıyı kaldır"
            : "Nasıl bir görsel istiyorsunuz? Örnek: koyu zeminde premium ürün çekimi, yumuşak yan ışık, metin yok"
        }
      />

      <div className="flex flex-wrap gap-2">
        {hasImage ? (
          <SubmitButton
            size="sm"
            name="mode"
            value="edit"
            disabled={!instruction.trim()}
          >
            <Wand2 className="size-4" />
            Bu görseli düzenle
          </SubmitButton>
        ) : null}

        <SubmitButton size="sm" variant="outline" name="mode" value="new">
          {hasImage ? (
            <Sparkles className="size-4" />
          ) : (
            <ImagePlus className="size-4" />
          )}
          {hasImage ? "Sıfırdan yeniden üret" : "Görsel üret"}
        </SubmitButton>
      </div>

      <p className="text-xs text-muted-foreground">
        {hasImage
          ? "Düzenleme mevcut görseli temel alır ve kompozisyonu korur. Sıfırdan üretim açıklamayı ve kreatif metnini kullanır; açıklama boşsa yalnızca metinden üretir."
          : "Açıklama boş bırakılırsa görsel, kreatifin başlık ve metninden üretilir."}
      </p>
      <p className="text-xs text-muted-foreground">
        Her üretim yeni bir sürüm oluşturur — eski görseller kaybolmaz.
      </p>
    </form>
  );
}
