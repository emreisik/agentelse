import { REVISION_POLICY } from "./plans";

// Bir gönderinin görselini düzenlemek ya da yeniden üretmek (Studio, "revize et")
// bir görsel modeli çağırır; hangi revizyonun hak yediğini bu dosya söyler. Saf
// (sunucu bağımlılığı yok), testli.
//
// Kural: gönderinin ANA görseli bir hak yer (iş, ilk çizim). Ondan sonra gönderi
// başına ilk `freePerPost` görsel revizyon ek hak yemez; sonrakilerin her biri 1
// hak yer. Karar sürüm NUMARASINDAN değil, sürüm GEÇMİŞİNDEN verilir: altyazı
// düzenlemesi ve alternatif seçimi de sürüm numarasını artırır ama görsel
// çizmez, "ücretsiz revizyon" hakkını yemez.
//
// Ücretsiz katman kötüye kullanılamaz olmalı: hak yemeyen yollarla (kütüphaneden
// yüklenen dosya, fotoğraftan kesilen gönderi, ana görselden uyarlanan görsel)
// oluşmuş bir görselin ÜSTÜNE çizilen ilk yapay zekâ görseli, hak yemiş bir
// çizimin "revizyonu" değil, yeni bir ana görseldir ve 1 hak yer.

export type RevisionVersion = {
  version: number;
  assetId: string | null;
  generationProvider: string | null;
  generationMetadata: unknown;
  revisionReason: string | null;
};

// performCreativeRevision'ın yazdığı gerekçeler ("Image edited per instruction: ...",
// "Image regenerated per instruction: ...", "Image regenerated"). Başka hiçbir yol
// bu önekleri yazmaz: görsel revizyonu sayan tek ölçü budur.
export function isImageRevision(version: RevisionVersion): boolean {
  const reason = version.revisionReason ?? "";
  return (
    reason.startsWith("Image edited") || reason.startsWith("Image regenerated")
  );
}

function metadataOf(version: RevisionVersion): Record<string, unknown> | null {
  const metadata = version.generationMetadata;
  return metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

// Hak yiyerek üretilmiş mi? (Hak yiyen revizyon bunu metadata'ya yazar.)
export function wasPaidRevision(version: RevisionVersion): boolean {
  return metadataOf(version)?.paid === true;
}

// Plan taslağı ve SEO takvimi görsel taşımaz; onların "sağlayıcısı" bir çizim değildir.
const NON_DRAWING_PROVIDERS = new Set(["plan-run", "seo-manager"]);

// Bu sürümün görseli bir yapay zekâ modelince ÇİZİLMİŞ mi? Çizilmemişler: görsel
// yok, kütüphaneden yüklenen dosya (sağlayıcı yok), markanın kendi fotoğrafından
// kesilen görsel (`photoSource`), ana görselden uyarlanan görsel (`adaptedFrom`).
export function pictureWasDrawn(version: RevisionVersion): boolean {
  if (!version.assetId || !version.generationProvider) return false;
  if (NON_DRAWING_PROVIDERS.has(version.generationProvider)) return false;
  const metadata = metadataOf(version);
  if (metadata?.photoSource) return false;
  if (typeof metadata?.adaptedFrom === "string") return false;
  return true;
}

export type RevisionQuote = {
  spendsRight: boolean;
  why:
    "photo-cut" | "first-picture" | "undrawn-picture" | "free" | "beyond-free";
};

// `versions`: gönderinin tüm sürümleri (sırasız olabilir). `cutsPhoto`: bu revizyon
// markanın fotoğrafını yeniden kesecek, hiçbir şey çizilmeyecek.
export function quoteRevision(input: {
  versions: readonly RevisionVersion[];
  cutsPhoto: boolean;
}): RevisionQuote {
  if (input.cutsPhoto) return { spendsRight: false, why: "photo-cut" };

  const current = [...input.versions].sort((a, b) => b.version - a.version)[0];
  if (!current?.assetId) return { spendsRight: true, why: "first-picture" };
  if (!pictureWasDrawn(current))
    return { spendsRight: true, why: "undrawn-picture" };

  const freeUsed = input.versions.filter(
    (version) => isImageRevision(version) && !wasPaidRevision(version),
  ).length;
  return freeUsed >= REVISION_POLICY.freePerPost
    ? { spendsRight: true, why: "beyond-free" }
    : { spendsRight: false, why: "free" };
}
