import {
  Clapperboard,
  FileText,
  GalleryHorizontal,
  ImageIcon,
  Megaphone,
  MessageSquare,
  Smartphone,
  Type,
  Video,
  type LucideIcon,
} from "lucide-react";

import {
  BrandIcon,
  type BrandKey,
} from "@/components/integrations/brand-icons";
import { cn } from "@/lib/utils";
import {
  CHANNELS,
  type ChannelKey,
  type FormatGlyph,
} from "@/lib/content-channels";

const GLYPH_ICON: Record<FormatGlyph, LucideIcon> = {
  image: ImageIcon,
  carousel: GalleryHorizontal,
  reel: Clapperboard,
  story: Smartphone,
  video: Video,
  text: Type,
  thread: MessageSquare,
  article: FileText,
  campaign: Megaphone,
};

// A format's icon (Reel -> clapperboard, Carousel -> gallery...).
export function FormatGlyphIcon({
  glyph,
  className,
}: {
  glyph: FormatGlyph;
  className?: string;
}) {
  const Icon = GLYPH_ICON[glyph];
  return <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden />;
}

// The social channels carry the same brand mark as their connector (the
// integrations page): one icon per platform in the chat's own UI, the plan card,
// the planner and the pieces. (The legacy chat keeps its coloured badge below.)
const BRAND_OF: Partial<Record<ChannelKey, BrandKey>> = {
  instagram: "instagram",
  tiktok: "tiktok",
  linkedin: "linkedin",
  x: "x",
};

// The platform's own brand icon; Blog/SEO and Ads (no brand mark) keep their
// short-code badge. `decorative`: the channel's name is written right beside it,
// so the mark is not announced a second time.
export function ChannelMark({
  channel,
  className,
  decorative,
}: {
  channel: ChannelKey;
  className?: string;
  decorative?: boolean;
}) {
  const brand = BRAND_OF[channel];
  if (!brand) {
    return (
      <ChannelBadge
        channel={channel}
        className={className}
        decorative={decorative}
      />
    );
  }
  const label = CHANNELS[channel].label;
  return (
    <span
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": label, title: label })}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-foreground",
        className,
      )}
    >
      <BrandIcon brand={brand} className="size-[70%]" />
    </span>
  );
}

// The channel's coloured mark. Lucide ships no brand icons, so each channel is
// a small solid badge with its short code; the same colour identifies it on
// the plan card, in the wizard and on the calendar.
export function ChannelBadge({
  channel,
  className,
  decorative,
}: {
  channel: ChannelKey;
  className?: string;
  // The channel's name is written right beside it: no tooltip, not announced.
  decorative?: boolean;
}) {
  const def = CHANNELS[channel];
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-[10px] leading-none font-bold text-white",
        className,
      )}
      style={{ background: def.color }}
      title={decorative ? undefined : def.label}
      aria-hidden={decorative || undefined}
    >
      {def.short}
    </span>
  );
}

// Green = can publish there now, amber = needs connecting, grey = not
// applicable (hand-off). Colour is never the only signal: callers add text.
export function ConnectionDot({
  state,
}: {
  state: "connected" | "missing" | "manual";
}) {
  return (
    <span
      className="inline-block size-1.5 shrink-0 rounded-full"
      style={{
        background:
          state === "connected"
            ? "var(--ws-approved)"
            : state === "missing"
              ? "var(--ws-pending)"
              : "var(--ws-text-3)",
      }}
      aria-hidden
    />
  );
}
