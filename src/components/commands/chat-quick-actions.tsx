"use client";

import { ImagePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { PublishTarget } from "@/server/integrations/meta-connection-status";
import type { QuickActionPlatform } from "@/server/actions/quick-action-actions";

const CREATE_LABEL: Record<QuickActionPlatform, string> = {
  instagram: "Create Instagram post",
  linkedin: "Create LinkedIn post",
  x: "Create X post",
};

// TikTok is deliberately excluded: CREATE_SOCIAL_CREATIVE only generates an
// image, but TIKTOK_PUBLISH requires a video asset (see publish-creative.ts)
// — a TikTok "create" shortcut here would produce an asset that can never
// actually be published there.
function isQuickActionPlatform(
  platform: PublishTarget["platform"],
): platform is QuickActionPlatform {
  return (
    platform === "instagram" || platform === "linkedin" || platform === "x"
  );
}

// The chat composer's integration quick-actions — one button per connected
// social platform (see getPublishTargets), so a common request ("create an
// Instagram post") is one click instead of typed free text. Renders nothing
// when no supported platform is connected, same "tied to integrations"
// principle as creative-card.tsx's PublishSection, whose button styling
// this mirrors.
export function ChatQuickActions({
  targets,
  disabled,
  onSelect,
}: {
  targets: PublishTarget[];
  disabled?: boolean;
  onSelect: (platform: QuickActionPlatform) => void;
}) {
  const platforms = targets
    .map((target) => target.platform)
    .filter(isQuickActionPlatform);

  if (platforms.length === 0) return null;

  return (
    <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-wrap items-center gap-2 px-4">
      {platforms.map((platform) => (
        <Button
          key={platform}
          type="button"
          variant="outline"
          size="sm"
          className="h-7 rounded-full px-2.5 text-xs"
          disabled={disabled}
          onClick={() => onSelect(platform)}
        >
          <ImagePlus className="size-3.5" />
          {CREATE_LABEL[platform]}
        </Button>
      ))}
    </div>
  );
}
