import type { CSSProperties, ReactNode } from "react";

import {
  ACCENT_HEX,
  DEFAULT_SHARE_FOOTER,
  type BrandingSnapshot,
} from "@/lib/report-share/types";

// Beyaz etiket çerçevesi (SC-F9 ve GA-F8 ortak): ajansın adı/logosu, vurgu
// çubuğu, başlık ve alt not. Hiçbir yerde Agentelse yazısı yoktur. Çerçeve
// HER ZAMAN açık renkli çizilir: genel sayfada ziyaretçinin koyu temasının
// rapor gövdesini okunmaz yapmaması ve yazdırmada beyaz zemin siyah yazı
// çıkması için tema belirteçleri burada açık değerlere sabitlenir (--ws-*
// belirteçleri :root'ta hesaplandığı için ayrıca yeniden tanımlanır).

const LIGHT_TOKENS = {
  colorScheme: "light",
  "--background": "oklch(1 0 0)",
  "--foreground": "oklch(0.19 0.014 260)",
  "--card": "oklch(1 0 0)",
  "--muted": "oklch(0.965 0.005 260)",
  "--muted-foreground": "oklch(0.5 0.018 260)",
  "--accent": "oklch(0.94 0.004 260)",
  "--border": "oklch(0.91 0.008 260)",
  "--primary": "oklch(0.19 0.014 260)",
  "--primary-foreground": "oklch(0.995 0.002 260)",
  "--warning": "oklch(0.685 0.16 63)",
  "--success": "oklch(0.6 0.135 155)",
  "--destructive": "oklch(0.577 0.245 27.325)",
  "--ws-bg": "oklch(1 0 0)",
  "--ws-surface": "oklch(1 0 0)",
  "--ws-surface-2": "oklch(0.965 0.005 260)",
  "--ws-hover": "oklch(0.94 0.004 260)",
  "--ws-border": "oklch(0.91 0.008 260)",
  "--ws-text": "oklch(0.19 0.014 260)",
  "--ws-text-body": "oklch(0.19 0.014 260)",
  "--ws-text-2": "oklch(0.5 0.018 260)",
  "--ws-text-3": "oklch(0.65 0.012 260)",
  "--ws-accent": "oklch(0.19 0.014 260)",
  "--ws-on-accent": "oklch(0.995 0.002 260)",
  "--ws-pending": "oklch(0.685 0.16 63)",
  "--ws-approved": "oklch(0.6 0.135 155)",
} as CSSProperties;

export function WhiteLabelFrame({
  branding,
  title,
  periodLabel,
  logoSrc,
  printable = false,
  children,
}: {
  branding: BrandingSnapshot;
  title: string;
  periodLabel: string | null;
  logoSrc: string | null;
  printable?: boolean;
  children: ReactNode;
}) {
  const accent = ACCENT_HEX[branding.accent];
  const footer = branding.footer?.trim() ? branding.footer : DEFAULT_SHARE_FOOTER;
  return (
    <div
      data-white-label="true"
      data-printable={printable ? "true" : "false"}
      style={LIGHT_TOKENS}
      className={
        "min-h-screen bg-white text-slate-900 print:min-h-0 print:bg-white print:text-black" +
        (printable ? " print:[&_section]:break-inside-avoid" : "")
      }
    >
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 print:max-w-none print:px-0 print:py-0">
        <header className="space-y-4">
          <div
            data-accent-bar="true"
            className="h-1.5 w-full rounded-full"
            style={{ backgroundColor: accent }}
          />
          <div className="flex items-center gap-3">
            {logoSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoSrc}
                alt={branding.displayName}
                referrerPolicy="no-referrer"
                className="h-auto max-h-10 w-auto max-w-[220px] object-contain"
                style={{ maxHeight: 40 }}
              />
            ) : (
              <span
                data-brand-name="true"
                className="text-lg font-semibold tracking-tight"
                style={{ color: accent }}
              >
                {branding.displayName}
              </span>
            )}
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {periodLabel ? (
              <p className="text-sm text-slate-600 print:text-black">
                {periodLabel}
              </p>
            ) : null}
          </div>
        </header>
        <main className="mt-6">{children}</main>
        <footer
          data-footer="true"
          className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-500 print:text-black"
        >
          {footer}
        </footer>
      </div>
    </div>
  );
}
