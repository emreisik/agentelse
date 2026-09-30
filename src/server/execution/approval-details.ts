import type {
  ApprovalLevel,
  ApprovalType,
  CapabilityKey,
} from "@prisma/client";

import {
  accountSetupPlatformName,
  isAccountSetupPlatform,
  missingCapabilityInput,
  missingInputAdvice,
} from "@/server/execution/capability-input";
import type { ApprovalCategory } from "@/types/idea-event-card";

// Plain-language bucket for a pending approval, shown on its chat card —
// campaign/budget writes are "spend" (real money, the one thing that must
// always stop and ask), social posts are "publish", everything else
// "action". LEVEL_4_CRITICAL is budget-adjacent by definition (see
// approval-policy.ts LEVEL_4_CAPABILITIES).
export function approvalCategory(
  type: ApprovalType,
  level: ApprovalLevel | null | undefined,
): ApprovalCategory {
  if (type === "CAMPAIGN_APPROVAL" || level === "LEVEL_4_CRITICAL") {
    return "spend";
  }
  if (type === "PUBLISH_APPROVAL") return "publish";
  return "action";
}

// Pure formatting — turns a Task's payload into human-readable rows for
// the approval-request chat card (see idea-event-card.tsx). Returns
// undefined for capabilities with nothing structured to show; callers
// (task-planner.ts) pass that straight through, so ordinary
// human-requested/creative approvals render exactly as before.
export function buildApprovalDetails(
  capability: CapabilityKey,
  payload: unknown,
): { label: string; value: string }[] | undefined {
  // Opening a new social account is High Risk and the task's title is only the
  // first 80 characters of whatever was asked, which says nothing about what
  // approving does. Say it.
  if (capability === "SOCIAL_ACCOUNT_SETUP") {
    const platform = (payload as { platform?: unknown } | null)?.platform;
    if (isAccountSetupPlatform(platform)) {
      return [
        { label: "Platform", value: accountSetupPlatformName(platform) },
        {
          label: "What happens",
          value: `A browser agent opens a new ${accountSetupPlatformName(platform)} account for the brand. You may be asked for a verification code along the way.`,
        },
      ];
    }
    // A task from before the platform check existed. Approving it is refused
    // (approval-decisions.ts); the card says why instead of promising work.
    const missing = missingCapabilityInput(capability, { platform });
    return [
      {
        label: "Platform",
        value:
          missing?.problem === "unsupported"
            ? `${missing.got} (not supported)`
            : "Not chosen",
      },
      {
        label: "What happens",
        value: missing ? missingInputAdvice(missing) : "This task cannot run.",
      },
    ];
  }
  if (
    capability !== "META_CAMPAIGN_UPDATE" &&
    capability !== "META_ADSET_UPDATE" &&
    capability !== "META_ADSET_CREATE" &&
    capability !== "META_AD_CREATE" &&
    capability !== "META_AD_UPDATE"
  ) {
    return undefined;
  }
  const p = (payload ?? {}) as Record<string, unknown>;

  const details: { label: string; value: string }[] = [];
  const current =
    typeof p.currentDailyBudgetCents === "number"
      ? p.currentDailyBudgetCents
      : undefined;
  const proposed =
    typeof p.proposedDailyBudgetCents === "number"
      ? p.proposedDailyBudgetCents
      : undefined;
  if (current !== undefined && proposed !== undefined) {
    details.push({
      label: "Daily budget",
      value: `${(current / 100).toFixed(2)} → ${(proposed / 100).toFixed(2)}`,
    });
  }
  if (typeof p.proposedStatus === "string") {
    details.push({ label: "Proposed status", value: p.proposedStatus });
  }
  if (typeof p.reason === "string") {
    details.push({ label: "Reason", value: p.reason });
  }

  if (capability === "META_ADSET_CREATE") {
    const dailyBudgetCents =
      typeof p.dailyBudgetCents === "number" ? p.dailyBudgetCents : undefined;
    if (dailyBudgetCents !== undefined) {
      details.push({
        label: "Daily budget",
        value: (dailyBudgetCents / 100).toFixed(2),
      });
    }
    const targeting = p.targeting as { countries?: unknown } | undefined;
    if (Array.isArray(targeting?.countries) && targeting.countries.length > 0) {
      details.push({
        label: "Countries",
        value: targeting.countries.join(", "),
      });
    }
    const pendingAd = p.pendingAd as Record<string, unknown> | undefined;
    if (pendingAd && typeof pendingAd.format === "string") {
      details.push({
        label: "Ad format",
        value: formatLabel(pendingAd.format, pendingAd.cards),
      });
    }
  }

  if (
    (capability === "META_AD_CREATE" || capability === "META_AD_UPDATE") &&
    typeof p.format === "string"
  ) {
    details.push({ label: "Format", value: formatLabel(p.format, p.cards) });
  }
  if (capability === "META_AD_UPDATE") {
    if (typeof p.name === "string") {
      details.push({ label: "Ad name", value: p.name });
    }
    // Surfaced so a reviewer approving a creative-content edit can at
    // least see the actual text/link being applied, and — for the image/
    // video slots — whether the update is uploading something brand new or
    // pointing the ad at a hash/id that already exists on the account
    // (rather than the field being silently invisible on the card). This
    // doesn't let a reviewer visually confirm a reused hash/id is the
    // RIGHT one (there's no thumbnail rendering in this plain-text card),
    // but it's a real improvement over showing nothing at all.
    if (typeof p.message === "string") {
      details.push({ label: "Primary text", value: p.message });
    }
    if (typeof p.link === "string") {
      details.push({ label: "Destination link", value: p.link });
    }
    if (typeof p.existingImageHash === "string") {
      details.push({
        label: "Image",
        value: `Reusing existing image (${p.existingImageHash.slice(0, 12)}…)`,
      });
    } else if (typeof p.imageAssetId === "string") {
      details.push({ label: "Image", value: "New upload" });
    }
    if (typeof p.existingVideoId === "string") {
      details.push({
        label: "Video",
        value: `Reusing existing video (${p.existingVideoId})`,
      });
    } else if (typeof p.videoAssetId === "string") {
      details.push({ label: "Video", value: "New upload" });
    }
    if (Array.isArray(p.cards)) {
      const reused = p.cards.filter(
        (c) =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as { existingImageHash?: unknown }).existingImageHash ===
            "string",
      ).length;
      if (reused > 0) {
        details.push({
          label: "Cards reusing an existing image",
          value: `${reused} of ${p.cards.length}`,
        });
      }
    }
  }

  return details.length > 0 ? details : undefined;
}

function formatLabel(format: string, cards: unknown): string {
  if (format === "CAROUSEL") {
    const count = Array.isArray(cards) ? cards.length : undefined;
    return count
      ? `Carousel (${count} card${count === 1 ? "" : "s"})`
      : "Carousel";
  }
  if (format === "VIDEO") return "Video";
  return "Single image";
}
