import {
  ACCENT_KEYS,
  BRANDING_FOOTER_MAX,
  BRANDING_NAME_MAX,
  type AccentKey,
  type BrandingSnapshot,
} from "./types";

// Marka girdisinin saf doğrulaması ve saklı anlık görüntünün güvenli okunması.

// C0/C1 denetim karakterleri ve satır/paragraf ayırıcıları (\n dahil).
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// Asset kimliği düz cuid benzeri bir dizgedir.
const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isAccentKey(value: string): value is AccentKey {
  return (ACCENT_KEYS as readonly string[]).includes(value);
}

export function validateBrandingInput(input: {
  displayName: string;
  accent: string;
  footer: string;
  logoAssetId: string;
}):
  | { ok: true; value: BrandingSnapshot }
  | { ok: false; message: string } {
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    return { ok: false, message: "Enter the name your clients should see." };
  }
  if (displayName.length > BRANDING_NAME_MAX) {
    return {
      ok: false,
      message: `The name can be at most ${BRANDING_NAME_MAX} characters.`,
    };
  }
  if (CONTROL_CHARS.test(displayName)) {
    return { ok: false, message: "The name can't contain control characters." };
  }
  if (!isAccentKey(input.accent)) {
    return { ok: false, message: "Choose one of the listed accent colors." };
  }
  const footer = input.footer.trim();
  if (footer.length > BRANDING_FOOTER_MAX) {
    return {
      ok: false,
      message: `The footer can be at most ${BRANDING_FOOTER_MAX} characters.`,
    };
  }
  if (CONTROL_CHARS.test(footer)) {
    return {
      ok: false,
      message: "The footer can't contain control characters.",
    };
  }
  const logo = input.logoAssetId.trim();
  if (logo !== "" && !ASSET_ID.test(logo)) {
    return { ok: false, message: "Choose a logo from the list." };
  }
  return {
    ok: true,
    value: {
      displayName,
      accent: input.accent,
      footer: footer === "" ? null : footer,
      logoAssetId: logo === "" ? null : logo,
    },
  };
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || text.length > max || CONTROL_CHARS.test(text)) return null;
  return text;
}

// Saklı JSON'dan okuma: bozuk ya da eksik alanlar varsayılana düşer, hiç
// fırlatmaz. Marka adı yoksa fallbackName kullanılır.
export function parseBrandingSnapshot(
  raw: unknown,
  fallbackName: string,
): BrandingSnapshot {
  const record =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const accent =
    typeof record.accent === "string" && isAccentKey(record.accent)
      ? record.accent
      : "slate";
  const logo =
    typeof record.logoAssetId === "string" && ASSET_ID.test(record.logoAssetId)
      ? record.logoAssetId
      : null;
  return {
    displayName:
      cleanText(record.displayName, BRANDING_NAME_MAX) ??
      (fallbackName.trim().slice(0, BRANDING_NAME_MAX) || "Report"),
    accent,
    footer: cleanText(record.footer, BRANDING_FOOTER_MAX),
    logoAssetId: logo,
  };
}
