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

// The channel's coloured mark. Lucide ships no brand icons, so each channel is
// a small solid badge with its short code; the same colour identifies it on
// the plan card, in the wizard and on the calendar.
export function ChannelBadge({
  channel,
  className,
}: {
  channel: ChannelKey;
  className?: string;
}) {
  const def = CHANNELS[channel];
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-[10px] leading-none font-bold text-white",
        className,
      )}
      style={{ background: def.color }}
      title={def.label}
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
