"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Megaphone } from "lucide-react";

import { ActionCard } from "@/components/works/action-card";
import { CardActions } from "@/components/works/card-actions";
import {
  disabledReasonOf,
  useWorkCardHost,
} from "@/components/works/work-card-host";
import type { CardButton } from "@/lib/works/card-action";
import {
  adsHref,
  isPauseProposal,
  proposalChangeText,
  type AdsInsightCardData,
} from "@/lib/works/ads-insight";
import { copyText } from "@/lib/works/copy";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";
import {
  pauseAllAdsFromCardAction,
  refreshAdsPulseAction,
  undoAdsDecisionFromCardAction,
} from "@/server/actions/work-ads-actions";

// The Meta Ads card (spec 3.12.5). Live data, never stored. Every state has
// exactly one primary action; an amount is printed only when the currency is
// known and has cents (proposalChangeText decides, never the stored text).

const INTEGRATION_HREF = (projectId: string) =>
  `/projects/${projectId}/integrations?integration=meta_ads`;

// "Oct 1": UTC so the server and the browser print the same day.
function asOfLabel(asOf?: string): string | null {
  if (!asOf) return null;
  const date = new Date(asOf);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

const TONE_COLOR: Record<"good" | "bad" | "neutral", string> = {
  good: "var(--ws-approved)",
  bad: "var(--destructive)",
  neutral: "var(--ws-text-3)",
};

function stateText(
  card: AdsInsightCardData,
  date: string | null,
): string | null {
  switch (card.state) {
    case "needs-connect":
      return copyText("ads.state.needsConnect");
    case "needs-account":
      return copyText("ads.state.needsAccount");
    case "no-data":
      return copyText("ads.state.noData");
    case "nothing":
      return copyText("ads.state.nothing");
    case "stale":
      return copyText("ads.state.stale", { date: date ?? "" });
    case "error":
      return copyText("ads.failed");
    default:
      return null;
  }
}

export function AdsInsightCard({
  card,
  initialView,
}: {
  card: AdsInsightCardData;
  // Lets a test render the open approval row and the dismissed line.
  initialView?: "review" | "dismissed";
}) {
  const host = useWorkCardHost();
  const router = useRouter();
  const [reviewing, setReviewing] = useState(initialView === "review");
  const [dismissed, setDismissed] = useState(initialView === "dismissed");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  if (!host) return null;

  const { projectId, workId } = host;
  const date = asOfLabel(card.asOf);
  const proposal = dismissed ? undefined : card.proposal;
  const gate = disabledReasonOf(host, { kind: "server" }) ?? undefined;

  const serverButton = (
    id: string,
    label: string,
    emphasis: CardButton["emphasis"],
  ): CardButton => ({
    id,
    label,
    emphasis,
    action: { kind: "server", id },
    disabledReason: gate,
  });
  const linkButton = (
    id: string,
    label: string,
    emphasis: CardButton["emphasis"],
    href: string,
  ): CardButton => ({ id, label, emphasis, action: { kind: "link", href } });

  const decide = async (
    id: string,
    approvalId: string,
    action: typeof approveApprovalAction,
    onDone?: () => void,
  ) => {
    setBusyId(id);
    setError(null);
    try {
      const formData = new FormData();
      formData.set("approvalId", approvalId);
      const result = await action(formData);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onDone?.();
      router.refresh();
      // Approve is the only path that does not show a line of its own.
      if (id === "ads:approve") host.announce(copyText("ads.approved"));
    } catch {
      setError(copyText("ads.failed"));
    } finally {
      setBusyId(null);
    }
  };

  const check = async () => {
    setBusyId("ads:check");
    setError(null);
    try {
      const result = await refreshAdsPulseAction(projectId, workId);
      if (result.ok) {
        // THROTTLED comes back as ok: nothing new to show, no refresh needed.
        if (result.state === "refreshed") router.refresh();
        // The date line may not change: say that the check happened.
        host.announce(copyText("ads.checked"));
        return;
      }
      if (result.code === "RECONNECT") {
        setReconnect(true);
        return;
      }
      if (result.code === "THROTTLED") return;
      setError(result.message || copyText("ads.failed"));
    } catch {
      setError(copyText("ads.failed"));
    } finally {
      setBusyId(null);
    }
  };

  const undo = async (decisionId: string) => {
    setBusyId("ads:undo");
    setError(null);
    try {
      const result = await undoAdsDecisionFromCardAction(projectId, decisionId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      host.announce(copyText("ads.undone"));
      router.refresh();
    } catch {
      setError(copyText("ads.failed"));
    } finally {
      setBusyId(null);
    }
  };

  const pauseAll = async () => {
    setBusyId("ads:pauseAllConfirm");
    setError(null);
    try {
      const result = await pauseAllAdsFromCardAction(projectId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setConfirmPause(false);
      host.announce(
        result.message ??
          (result.paused === 0
            ? copyText("ads.pausedNothing")
            : copyText("ads.pausedAll", { n: String(result.paused) })),
      );
      router.refresh();
    } catch {
      setError(copyText("ads.failed"));
    } finally {
      setBusyId(null);
    }
  };

  const onAct = (button: CardButton) => {
    switch (button.id) {
      case "ads:undo":
        if (card.undo) void undo(card.undo.decisionId);
        return;
      case "ads:pauseAll":
        setConfirmPause(true);
        return;
      case "ads:pauseAllConfirm":
        void pauseAll();
        return;
      case "ads:pauseAllCancel":
        setConfirmPause(false);
        return;
      case "ads:review":
        setReviewing(true);
        return;
      case "ads:approve":
        if (proposal)
          void decide(button.id, proposal.approvalId, approveApprovalAction);
        return;
      case "ads:dismiss":
        if (proposal) {
          void decide(
            button.id,
            proposal.approvalId,
            rejectApprovalAction,
            () => {
              setDismissed(true);
              setReviewing(false);
            },
          );
        }
        return;
      case "ads:check":
        void check();
        return;
    }
  };

  const buttons: CardButton[] = [];
  const integration = INTEGRATION_HREF(projectId);
  const checking = busyId === "ads:check";

  if (proposal?.state === "changed") {
    buttons.push(
      serverButton("ads:dismiss", copyText("ads.dismiss"), "primary"),
    );
  } else if (proposal) {
    if (!reviewing) {
      buttons.push(
        serverButton(
          "ads:review",
          copyText(
            isPauseProposal(proposal) ? "ads.pauseReview" : "ads.budgetApproval",
          ),
          "primary",
        ),
      );
    }
  } else if (reconnect) {
    buttons.push(
      linkButton(
        "ads:reconnect",
        copyText("ads.reconnect"),
        "primary",
        integration,
      ),
    );
  } else if (card.state === "needs-connect") {
    buttons.push(
      linkButton(
        "ads:connect",
        copyText("ads.connect"),
        "primary",
        integration,
      ),
    );
  } else if (card.state === "needs-account") {
    buttons.push(
      linkButton(
        "ads:pick",
        copyText("ads.pickAccount"),
        "primary",
        integration,
      ),
    );
  } else {
    buttons.push(
      serverButton(
        "ads:check",
        checking ? copyText("ads.checking") : copyText("ads.check"),
        "primary",
      ),
    );
  }

  const connected =
    card.state !== "needs-connect" && card.state !== "needs-account";
  if (connected && card.campaignId) {
    buttons.push(
      linkButton(
        "ads:preview",
        copyText("ads.preview"),
        "secondary",
        adsHref(projectId, { campaignDetail: card.campaignId }),
      ),
    );
  }
  if (connected) {
    buttons.push(
      linkButton("ads:open", copyText("ads.open"), "quiet", adsHref(projectId)),
    );
  }
  // F4: son uygulanan değişikliği geri al.
  if (connected && card.undo && !proposal) {
    buttons.push(serverButton("ads:undo", copyText("ads.undo"), "quiet"));
  }
  // Pause all: açık kampanya varken her zaman erişilebilir (F2).
  if (connected && card.pauseAll && !confirmPause) {
    buttons.push(serverButton("ads:pauseAll", copyText("ads.pauseAll"), "quiet"));
  }
  const pauseButtons: CardButton[] =
    confirmPause && card.pauseAll
      ? [
          serverButton(
            "ads:pauseAllConfirm",
            copyText("ads.pauseAllConfirm", { n: String(card.pauseAll.campaigns) }),
            "primary",
          ),
          serverButton("ads:pauseAllCancel", copyText("ads.cancel"), "quiet"),
        ]
      : [];

  const text = stateText(card, date);
  const showApprovalRow = proposal?.state === "pending" && reviewing;
  const rowButtons: CardButton[] = showApprovalRow
    ? [
        serverButton(
          "ads:approve",
          copyText(
            proposal && isPauseProposal(proposal)
              ? "ads.approvePause"
              : "ads.approveSpend",
          ),
          "primary",
        ),
        serverButton("ads:dismiss", copyText("ads.dismiss"), "quiet"),
      ]
    : [];
  // Only one primary may exist: with a row open the footer has none.
  const footer =
    showApprovalRow || pauseButtons.length > 0
      ? buttons.filter((button) => button.emphasis !== "primary")
      : buttons;

  return (
    <ActionCard
      icon={Megaphone}
      title={
        card.state === "ok" && card.headline
          ? card.headline
          : copyText("ads.heading")
      }
      reason={card.state === "ok" && card.headline ? copyText("ads.heading") : undefined}
      width="wide"
      cardId="ads-insight"
      actions={
        <CardActions
          buttons={footer}
          busyId={busyId}
          error={error}
          onAct={onAct}
        />
      }
    >
      <div className="space-y-2">
        {card.alerts && card.alerts.length > 0 ? (
          <ul className="space-y-1.5" aria-label={copyText("ads.alerts")}>
            {card.alerts.map((alert) => (
              <li
                key={alert.id}
                className="flex items-start gap-2 rounded-xl border px-2.5 py-2 text-sm"
                style={{
                  borderColor:
                    alert.severity === "CRITICAL"
                      ? "var(--destructive)"
                      : "var(--ws-border)",
                  color: "var(--ws-text)",
                }}
              >
                <span
                  aria-hidden="true"
                  className="mt-1.5 size-1.5 shrink-0 rounded-full"
                  style={{
                    background:
                      alert.severity === "CRITICAL"
                        ? "var(--destructive)"
                        : "var(--ws-text-3)",
                  }}
                />
                {alert.title}
              </li>
            ))}
          </ul>
        ) : null}
        {pauseButtons.length > 0 ? (
          <div
            className="rounded-xl border p-2.5"
            style={{ borderColor: "var(--ws-border)" }}
          >
            <CardActions buttons={pauseButtons} busyId={busyId} onAct={onAct} />
          </div>
        ) : null}
        {text ? (
          <p className="text-sm" style={{ color: "var(--ws-text)" }}>
            {text}
          </p>
        ) : null}
        {card.chips.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {card.chips.map((chip) => (
              <li
                key={`${chip.label}:${chip.value}`}
                className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
                style={{
                  borderColor: "var(--ws-border)",
                  color: "var(--ws-text)",
                }}
              >
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full"
                  style={{ background: TONE_COLOR[chip.tone ?? "neutral"] }}
                />
                <span style={{ color: "var(--ws-text-2)" }}>{chip.label}</span>
                {chip.label.includes(chip.value) ? null : (
                  <span className="font-medium">{chip.value}</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {dismissed ? (
          <p
            className="text-xs"
            role="status"
            style={{ color: "var(--ws-text-2)" }}
          >
            {copyText("ads.dismissed")}
          </p>
        ) : null}
        {proposal?.state === "changed" ? (
          <p className="text-sm" style={{ color: "var(--ws-text)" }}>
            {copyText("ads.changed")}
          </p>
        ) : null}
        {showApprovalRow && proposal ? (
          <div
            className="space-y-2 rounded-xl border p-2.5"
            style={{ borderColor: "var(--ws-border)" }}
          >
            <p className="text-sm" style={{ color: "var(--ws-text)" }}>
              {proposalChangeText(
                proposal.currentDailyBudgetCents,
                proposal.proposedDailyBudgetCents,
                card.currency,
                proposal.proposedStatus,
              )}
            </p>
            {proposal.reason ? (
              <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
                <span className="font-medium">{copyText("ads.why")}: </span>
                {proposal.reason}
              </p>
            ) : null}
            <CardActions buttons={rowButtons} busyId={busyId} onAct={onAct} />
          </div>
        ) : null}
        {date && card.state !== "stale" ? (
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {copyText("ads.asOf", { date })}
          </p>
        ) : null}
      </div>
    </ActionCard>
  );
}
