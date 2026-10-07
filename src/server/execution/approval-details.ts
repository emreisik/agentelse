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
import { formatMoney } from "@/lib/ads/money";
import { gaFixApprovalDetails } from "@/lib/website-analytics/fixes/approval-details";
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
  // GA-F7: kartın satırları kendi yük metninden okunur (mülk adı taşımaz).
  if (capability === "ANALYTICS_EDIT") return gaFixApprovalDetails(payload);

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
  if (capability === "META_CAMPAIGN_CREATE") {
    return campaignCreateDetails((payload ?? {}) as Record<string, unknown>);
  }
  if (capability === "META_LAUNCH") {
    return launchDetails((payload ?? {}) as Record<string, unknown>);
  }
  if (capability === "META_SAFETY_ACTION") {
    const p = (payload ?? {}) as Record<string, unknown>;
    return [
      {
        label: "What happens",
        value:
          p.action === "PAUSE_ALL"
            ? "Every running campaign in the ad account is paused."
            : p.action === "DISCARD_LAUNCH"
              ? "The half-made campaign is removed from the ad account."
              : "The ad is paused.",
      },
      ...(typeof p.reason === "string" ? [{ label: "Reason", value: p.reason }] : []),
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
  // Tutarlar minor unit'tir; para birimi görev yükündedir (onay anının
  // hesabı). Yoksa formatMoney "(account currency)" der, tutar uydurmaz.
  const currency = typeof p.currency === "string" ? p.currency : undefined;

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
      value: `${formatMoney(current, currency)} → ${formatMoney(proposed, currency)}`,
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
        value: formatMoney(dailyBudgetCents, currency),
      });
    }
    const runs = runsForText(p.durationDays);
    if (runs) details.push({ label: "Runs for", value: runs });
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

// "7 days from creation, then Meta stops it" — süre, ad set kurulurken
// başlar (docs/meta-ads-plan.md F0b).
function runsForText(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return `${value} days from creation, then Meta stops it`;
}

// META_CAMPAIGN_CREATE: zincirin ilk halkası onaylanırken kullanıcı aslında
// ad set'in bütçesini ve süresini de onaylıyor; kart bunları gösterir.
function campaignCreateDetails(
  p: Record<string, unknown>,
): { label: string; value: string }[] | undefined {
  const details: { label: string; value: string }[] = [];
  if (typeof p.objective === "string") {
    details.push({ label: "Objective", value: objectiveLabel(p.objective) });
  }
  const pending = (p.__pendingAdSet ?? null) as Record<string, unknown> | null;
  const currency =
    typeof pending?.currency === "string"
      ? pending.currency
      : typeof p.currency === "string"
        ? p.currency
        : undefined;
  if (pending && typeof pending.dailyBudgetCents === "number") {
    details.push({
      label: "Daily budget",
      value: formatMoney(pending.dailyBudgetCents, currency),
    });
  }
  const runs = runsForText(pending?.durationDays);
  if (runs) details.push({ label: "Runs for", value: runs });
  const targeting = pending?.targeting as { countries?: unknown } | undefined;
  if (Array.isArray(targeting?.countries) && targeting.countries.length > 0) {
    details.push({ label: "Countries", value: targeting.countries.join(", ") });
  }
  return details.length > 0 ? details : undefined;
}

function objectiveLabel(objective: string): string {
  const known: Record<string, string> = {
    OUTCOME_TRAFFIC: "Traffic",
    OUTCOME_AWARENESS: "Awareness",
    OUTCOME_ENGAGEMENT: "Engagement",
    OUTCOME_LEADS: "Leads",
    OUTCOME_SALES: "Sales",
    OUTCOME_APP_PROMOTION: "App promotion",
  };
  return known[objective] ?? objective;
}

// Güvenli lansmanın tek onayı (docs/meta-ads-plan.md §3.4 adım 5): net zarf,
// bitiş, hesap, amaç, kitle ve Meta'nın gün içi temposu. Görev yükündeki
// `summary` planlama anında yazılır (bu dosya saf kalır).
function launchDetails(
  p: Record<string, unknown>,
): { label: string; value: string }[] {
  const summary = (p.summary ?? {}) as Record<string, unknown>;
  const currency = typeof summary.currency === "string" ? summary.currency : undefined;
  const rows: { label: string; value: string }[] = [];
  const mode = p.mode === "activate" ? "activate" : p.mode === "discard" ? "discard" : "create";
  if (typeof summary.addingTo === "string") {
    rows.push({
      label: "What happens",
      value: "New ads are added to an ad set that's already running. Its budget, schedule and audience stay as they are.",
    });
    return rows;
  }
  if (mode === "activate") {
    rows.push({ label: "What happens", value: "The campaign is turned on in Meta. Delivery starts after Meta's review." });
  } else if (mode === "discard") {
    rows.push({ label: "What happens", value: "The half-made campaign is removed from the ad account." });
  }
  if (typeof summary.envelopeMinor === "number") {
    rows.push({ label: "Total budget (net)", value: formatMoney(summary.envelopeMinor, currency) });
  }
  if (typeof summary.dailyMinor === "number" && typeof summary.days === "number") {
    rows.push(
      summary.budgetMode === "FIXED"
        ? {
            label: "Budget",
            value: `Spread over ${summary.days} day${summary.days === 1 ? "" : "s"}; Meta spends more on better days`,
          }
        : {
            label: "Daily budget",
            value: `${formatMoney(summary.dailyMinor, currency)} for ${summary.days} day${summary.days === 1 ? "" : "s"}`,
          },
    );
  }
  if (summary.leadForm === true) {
    rows.push({ label: "Form", value: "An instant form (name, phone, email) is created on your Page." });
  }
  if (typeof summary.spendCapMinor === "number") {
    rows.push({ label: "Campaign spending limit", value: formatMoney(summary.spendCapMinor, currency) });
  }
  if (typeof summary.objective === "string") rows.push({ label: "Goal", value: summary.objective });
  if (typeof summary.audience === "string") rows.push({ label: "Audience", value: summary.audience });
  if (typeof summary.account === "string") rows.push({ label: "Ad account", value: summary.account });
  if (typeof summary.page === "string") rows.push({ label: "Runs as", value: summary.page });
  if (mode === "create") {
    rows.push({
      label: "End",
      value: `Meta stops it by itself after ${typeof summary.days === "number" ? summary.days : "the planned"} days${summary.timezone ? ` (account time, ${summary.timezone})` : ""}. Turning it on later does not move the end date.`,
    });
    rows.push({
      label: "Pacing",
      value: "Meta may spend up to 1.75× your daily budget on some days; the weekly total stays within 7×.",
    });
    if (summary.activate === false) {
      rows.push({ label: "After creation", value: "Created paused. You turn it on later." });
    }
  }
  return rows;
}
