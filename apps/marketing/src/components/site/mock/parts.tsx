import type { IconType } from "react-icons";
import { FaLinkedin } from "react-icons/fa6";
import {
  SiFacebook,
  SiGoogleanalytics,
  SiGooglesearchconsole,
  SiInstagram,
  SiMeta,
  SiTelegram,
  SiTiktok,
  SiX,
} from "react-icons/si";

import { cn } from "@/lib/utils";

// Small building blocks shared by the product mock-ups. They copy the app's
// look (cards, pills, icons, copy) so every illustration on the site reads as
// the real product, not a generic SaaS drawing.

export type Platform =
  | "instagram"
  | "facebook"
  | "tiktok"
  | "linkedin"
  | "x"
  | "telegram"
  | "meta-ads"
  | "analytics"
  | "search-console";

export const PLATFORMS: Record<
  Platform,
  { name: string; Icon: IconType; color: string }
> = {
  instagram: { name: "Instagram", Icon: SiInstagram, color: "#E1306C" },
  facebook: { name: "Facebook", Icon: SiFacebook, color: "#0866FF" },
  tiktok: { name: "TikTok", Icon: SiTiktok, color: "#111111" },
  linkedin: { name: "LinkedIn", Icon: FaLinkedin, color: "#0A66C2" },
  x: { name: "X", Icon: SiX, color: "#111111" },
  telegram: { name: "Telegram", Icon: SiTelegram, color: "#26A5E4" },
  "meta-ads": { name: "Meta Ads", Icon: SiMeta, color: "#0866FF" },
  analytics: {
    name: "Google Analytics",
    Icon: SiGoogleanalytics,
    color: "#E37400",
  },
  "search-console": {
    name: "Search Console",
    Icon: SiGooglesearchconsole,
    color: "#4285F4",
  },
};

export function PlatformIcon({
  platform,
  className,
  colored = false,
}: {
  platform: Platform;
  className?: string;
  colored?: boolean;
}) {
  const { Icon, color, name } = PLATFORMS[platform];
  return (
    <Icon
      aria-label={name}
      role="img"
      className={cn("size-3.5 shrink-0", className)}
      style={colored ? { color } : undefined}
    />
  );
}

export type PillTone = "neutral" | "waiting" | "positive" | "live" | "danger";

const PILL_TONES: Record<PillTone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  waiting: "bg-[oklch(0.96_0.05_80)] text-[oklch(0.5_0.12_65)]",
  positive: "bg-[oklch(0.96_0.04_152)] text-[oklch(0.45_0.12_152)]",
  live: "bg-spark-soft text-spark",
  danger: "bg-[oklch(0.96_0.03_27)] text-destructive",
};

export function Pill({
  tone = "neutral",
  children,
  className,
  dot = false,
}: {
  tone?: PillTone;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap",
        PILL_TONES[tone],
        className,
      )}
    >
      {dot ? (
        <span className="site-pulse size-1.5 rounded-full bg-current" />
      ) : null}
      {children}
    </span>
  );
}

// A mock-up surface: the app's card (border, soft shadow, 16px radius).
export function MockCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card text-card-foreground shadow-[var(--shadow-card)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MockButton({
  children,
  variant = "primary",
  className,
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-[12px] font-medium whitespace-nowrap",
        variant === "primary" && "bg-primary text-primary-foreground",
        variant === "secondary" && "bg-secondary text-foreground",
        variant === "ghost" && "text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

// The fictional brand every mock-up uses.
export const DEMO_BRAND = {
  name: "Mira Coffee",
  handle: "@miracoffee",
  site: "miracoffee.com",
  initial: "M",
  colors: ["#2B1D16", "#C8742F", "#F3E7D8", "#6F7F5C"],
} as const;

export function BrandAvatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-[#F3E7D8]",
        className,
      )}
      style={{ background: DEMO_BRAND.colors[0] }}
    >
      {DEMO_BRAND.initial}
    </span>
  );
}

// A designed post picture, drawn in CSS: the brand's colours, a headline in
// its layout, and the logo band the app lays on pixel-exact.
export function PostArt({
  headline,
  kicker,
  tone = "warm",
  className,
  aspect = "aspect-[4/5]",
}: {
  headline: string;
  kicker?: string;
  tone?: "warm" | "dark" | "sage" | "cream";
  className?: string;
  aspect?: string;
}) {
  const palette = {
    warm: {
      bg: "linear-gradient(160deg,#D8894A 0%,#B4612A 55%,#7A3E1C 100%)",
      ink: "#FFF6EC",
    },
    dark: {
      bg: "linear-gradient(160deg,#3A2A21 0%,#2B1D16 60%,#1C130E 100%)",
      ink: "#F3E7D8",
    },
    sage: {
      bg: "linear-gradient(160deg,#8C9A78 0%,#6F7F5C 60%,#55633F 100%)",
      ink: "#F7F3EA",
    },
    cream: {
      bg: "linear-gradient(160deg,#FBF4EA 0%,#F3E7D8 60%,#E9D7C1 100%)",
      ink: "#2B1D16",
    },
  }[tone];

  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden",
        aspect,
        className,
      )}
      style={{ background: palette.bg, color: palette.ink }}
    >
      {/* the "photo": soft shapes standing in for a cup and steam */}
      <div aria-hidden="true" className="absolute inset-0">
        <div
          className="absolute right-[-12%] bottom-[14%] h-[52%] w-[62%] rounded-full opacity-30 blur-[2px]"
          style={{
            background:
              "radial-gradient(circle at 40% 35%, #fff 0%, transparent 62%)",
          }}
        />
        <div
          className="absolute right-[12%] bottom-[22%] h-[30%] w-[34%] rounded-b-[45%] rounded-t-[12%] opacity-90"
          style={{
            background: tone === "cream" ? "#2B1D16" : "#F3E7D8",
            boxShadow: "inset -8px -10px 0 rgb(0 0 0 / 0.08)",
          }}
        />
        <div
          className="absolute right-[14%] bottom-[47%] h-[9%] w-[30%] rounded-full opacity-60"
          style={{ background: tone === "cream" ? "#C8742F" : "#7A3E1C" }}
        />
      </div>
      <div className="relative flex flex-1 flex-col justify-start gap-1 p-[8%]">
        {kicker ? (
          <span className="text-[0.55em] font-semibold tracking-[0.18em] uppercase opacity-80">
            {kicker}
          </span>
        ) : null}
        <span className="max-w-[70%] text-[1em] leading-[1.05] font-semibold tracking-tight">
          {headline}
        </span>
      </div>
      <div
        className="relative flex items-center justify-between px-[8%] py-[4%] text-[0.5em] font-semibold tracking-wide"
        style={{ background: "rgb(0 0 0 / 0.18)" }}
      >
        <span>MIRA COFFEE</span>
        <span className="opacity-80">miracoffee.com</span>
      </div>
    </div>
  );
}
