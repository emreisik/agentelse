"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Check, Loader2, X } from "lucide-react";

import { CardActions } from "@/components/works/card-actions";
import { useWorkCardHost } from "@/components/works/work-card-host";
import {
  approvalLinkOf,
  isChainMoving,
  type AdsChain,
  type ChainLink,
  type ChainLinkState,
} from "@/lib/module-flows/ads/chain";
import {
  ADS_FLOW_COPY,
  CHAIN_LINK_LABEL,
  CHAIN_STATE_LABEL,
} from "@/lib/module-flows/ads/copy";
import type { CardButton } from "@/lib/works/card-action";
import { adsHref } from "@/lib/works/ads-insight";
import { approveApprovalAction } from "@/server/actions/approval-actions";
import {
  loadAdsLaunchAction,
  relaunchAdsAction,
} from "@/server/actions/ads-flow-actions";
import {
  discardAdsLaunchAction,
  retryAdsLaunchAction,
  turnOnAdsLaunchAction,
} from "@/server/actions/ads-launch-actions";

import { LoadingLine, type StepActions } from "./parts";

// Step 5, Launch: the campaign, the ad set and the ad, each created PAUSED in
// Meta behind its own approval, read live from the card's lineage. An approval
// waiting for the person is approved right here; while Meta works the card
// reads again on its own for a while, and Refresh reads at any time.

const COPY = ADS_FLOW_COPY;
const POLL_MS = 5_000;
// About three minutes of reading on its own, then Refresh.
const POLL_LIMIT = 36;

const SPOKEN: ReadonlySet<ChainLinkState> = new Set([
  "approval",
  "created",
  "failed",
  "declined",
]);

// "Ad set: Waiting for your approval", for the first link whose state moved
// to one the person would want to hear about.
export function changeOf(
  before: AdsChain | null,
  after: AdsChain,
): string | null {
  if (!before) return null;
  for (const link of after.links) {
    const was = before.links.find((old) => old.key === link.key)?.state;
    if (was !== link.state && SPOKEN.has(link.state)) {
      return `${CHAIN_LINK_LABEL[link.key]}: ${CHAIN_STATE_LABEL[link.state]}`;
    }
  }
  return null;
}

export type AdsChainRead = {
  chain: AdsChain | null;
  error: string | null;
  // Reading again stopped on its own: Refresh to check.
  idle: boolean;
  reload: () => Promise<void>;
};

export function useAdsChain({
  projectId,
  commandId,
  enabled,
  initial,
}: {
  projectId: string;
  commandId: string;
  enabled: boolean;
  initial?: AdsChain;
}): AdsChainRead {
  const host = useWorkCardHost();
  const [chain, setChain] = useState<AdsChain | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [idle, setIdle] = useState(false);
  const [, startReading] = useTransition();
  const polls = useRef(0);
  const live = useRef(true);
  const last = useRef<AdsChain | null>(initial ?? null);
  const announce = useRef(host?.announce);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    announce.current = host?.announce;
  });

  const read = useCallback(async () => {
    const result = await loadAdsLaunchAction(projectId, commandId).catch(
      () => null,
    );
    if (!live.current) return;
    if (result?.ok) {
      // A link that moved on its own is spoken (never on the first read).
      const said = changeOf(last.current, result.chain);
      if (said) announce.current?.(said);
      last.current = result.chain;
      setChain(result.chain);
      setError(null);
    } else {
      setError(result?.message || COPY.loadFailed);
    }
  }, [projectId, commandId]);

  // The first read when the step shows.
  useEffect(() => {
    if (!enabled || initial) return;
    startReading(() => read());
  }, [enabled, initial, read]);

  // While Meta works on a link, read again every few seconds, for a while.
  useEffect(() => {
    if (!enabled || !chain || !isChainMoving(chain)) {
      polls.current = 0;
      return;
    }
    if (polls.current >= POLL_LIMIT) return;
    const timer = setTimeout(() => {
      polls.current += 1;
      startReading(async () => {
        await read();
        if (polls.current >= POLL_LIMIT && live.current) setIdle(true);
      });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [enabled, chain, read]);

  const reload = useCallback(async () => {
    polls.current = 0;
    setIdle(false);
    await read();
  }, [read]);

  return { chain, error, idle, reload };
}

const STATE_TONE: Record<ChainLinkState, string> = {
  waiting: "var(--ws-text-3)",
  preparing: "var(--ws-text-2)",
  approval: "var(--ws-pending)",
  running: "var(--ws-text-2)",
  created: "var(--ws-approved)",
  failed: "var(--destructive)",
  declined: "var(--destructive)",
  blocked: "var(--ws-text-3)",
};

function LinkMark({ link, index }: { link: ChainLink; index: number }) {
  const base =
    "grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold";
  if (link.state === "created") {
    return (
      <span
        className={base}
        style={{
          background:
            "color-mix(in oklch, var(--ws-approved) 16%, transparent)",
          color: "var(--ws-approved)",
        }}
      >
        <Check aria-hidden="true" className="size-3.5" />
      </span>
    );
  }
  if (link.state === "failed" || link.state === "declined") {
    return (
      <span
        className={base}
        style={{
          background:
            "color-mix(in oklch, var(--destructive) 14%, transparent)",
          color: "var(--destructive)",
        }}
      >
        <X aria-hidden="true" className="size-3.5" />
      </span>
    );
  }
  if (link.state === "running" || link.state === "preparing") {
    return (
      <span className={base} style={{ color: "var(--ws-text-2)" }}>
        <Loader2
          aria-hidden="true"
          className="size-3.5 animate-spin motion-reduce:animate-none"
        />
      </span>
    );
  }
  return (
    <span
      className={base}
      style={{
        border: "1px solid var(--ws-border)",
        color:
          link.state === "approval" ? "var(--ws-text)" : "var(--ws-text-3)",
      }}
    >
      {index + 1}
    </span>
  );
}

export function AdsLaunchStep({
  projectId,
  commandId,
  read,
  gate,
  actions,
}: {
  projectId: string;
  commandId: string;
  read: AdsChainRead;
  gate: string | null;
  actions: StepActions;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const { chain, error, idle } = read;

  if (!chain) {
    return error ? (
      <div className="space-y-2">
        <p role="alert" className="text-sm" style={{ color: "var(--ws-text)" }}>
          {error}
        </p>
        <CardActions
          buttons={[
            {
              id: "launch:refresh",
              label: COPY.refresh,
              emphasis: "secondary",
              action: { kind: "server", id: "launch:refresh" },
            },
          ]}
          busyId={refreshing ? "launch:refresh" : null}
          onAct={() => {
            setRefreshing(true);
            void read.reload().finally(() => setRefreshing(false));
          }}
        />
      </div>
    ) : (
      <LoadingLine className="py-2">{COPY.checking}</LoadingLine>
    );
  }

  const pending = approvalLinkOf(chain);

  const approve = async (link: ChainLink) => {
    const approvalId = link.approvalId;
    if (!approvalId) return;
    await actions.run(
      `approve:${link.key}`,
      () => {
        const formData = new FormData();
        formData.set("approvalId", approvalId);
        return approveApprovalAction(formData);
      },
      { announce: COPY.approved },
    );
    await read.reload();
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await read.reload();
    } finally {
      setRefreshing(false);
    }
  };

  const footer: CardButton[] = [];
  const v2 = chain.v2;
  const serverButton = (
    id: string,
    label: string,
    emphasis: CardButton["emphasis"],
  ): CardButton => ({
    id,
    label,
    emphasis,
    action: { kind: "server", id },
    disabledReason: gate ?? undefined,
  });
  if (v2 && v2.canRetry) {
    footer.push(serverButton("launch:retry", COPY.retry, "primary"));
    footer.push(serverButton("launch:discard", COPY.discard, "quiet"));
  } else if (v2 && v2.canTurnOn) {
    footer.push(serverButton("launch:turnon", COPY.turnOnNow, "primary"));
    footer.push(serverButton("launch:discard", COPY.discard, "quiet"));
  }
  if (v2 && (v2.canRetry || v2.canTurnOn)) {
    // v2'nin kendi düğmeleri yukarıda.
  } else if (chain.complete) {
    footer.push({
      id: "launch:open",
      label: COPY.openAds,
      emphasis: "primary",
      action: {
        kind: "link",
        href: adsHref(
          projectId,
          chain.campaignId ? { campaignDetail: chain.campaignId } : {},
        ),
      },
    });
  } else if (chain.stopped) {
    footer.push({
      id: "launch:relaunch",
      label: COPY.relaunch,
      emphasis: "primary",
      action: { kind: "server", id: "launch:relaunch" },
      disabledReason: gate ?? undefined,
    });
  }
  if (!chain.complete) {
    footer.push({
      id: "launch:refresh",
      label: COPY.refresh,
      emphasis: "quiet",
      action: { kind: "server", id: "launch:refresh" },
    });
  }

  const onFooter = (button: CardButton) => {
    if (button.id === "launch:retry") {
      void actions
        .run(button.id, () => retryAdsLaunchAction(projectId, commandId), {
          announce: COPY.approved,
        })
        .then(() => read.reload());
    } else if (button.id === "launch:turnon") {
      void actions
        .run(button.id, () => turnOnAdsLaunchAction(projectId, commandId), {
          announce: COPY.approved,
        })
        .then(() => read.reload());
    } else if (button.id === "launch:discard") {
      void actions
        .run(button.id, () => discardAdsLaunchAction(projectId, commandId), {
          announce: COPY.discarded,
        })
        .then(() => read.reload());
    } else if (button.id === "launch:refresh") {
      void refresh();
    } else if (button.id === "launch:relaunch") {
      void actions.run(
        button.id,
        () => relaunchAdsAction(projectId, commandId),
        { moves: true },
      );
    }
  };

  return (
    <div className="space-y-3">
      <ol aria-label={COPY.chainAria} className="space-y-2">
        {chain.links.map((link, index) => {
          const isPending = pending?.key === link.key;
          return (
            <li
              key={link.key}
              data-link={link.key}
              data-state={link.state}
              className="space-y-2 rounded-xl border p-2.5"
              style={{ borderColor: "var(--ws-border)" }}
            >
              <div className="flex items-start gap-2.5">
                <LinkMark link={link} index={index} />
                <div className="min-w-0 flex-1">
                  <p
                    className="text-sm font-medium"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {CHAIN_LINK_LABEL[link.key]}
                  </p>
                  <p
                    className="text-xs"
                    style={{ color: STATE_TONE[link.state] }}
                  >
                    {CHAIN_STATE_LABEL[link.state]}
                  </p>
                  {link.reason ? (
                    <p
                      className="mt-0.5 text-xs break-words"
                      style={{ color: "var(--ws-text-2)" }}
                    >
                      {link.reason}
                    </p>
                  ) : null}
                </div>
              </div>
              {isPending ? (
                <CardActions
                  buttons={[
                    {
                      id: `approve:${link.key}`,
                      label: v2
                        ? COPY.approveLaunch
                        : `${COPY.approve} ${CHAIN_LINK_LABEL[link.key].toLowerCase()}`,
                      emphasis: "primary",
                      action: { kind: "server", id: `approve:${link.key}` },
                      disabledReason: gate ?? undefined,
                    },
                  ]}
                  busyId={actions.busyId}
                  onAct={() => void approve(link)}
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      {v2 && (v2.live || v2.status === "CREATED_PAUSED" || v2.status === "DISCARDED") ? (
        <div className="space-y-0.5 text-sm" role="status">
          <p className="font-medium" style={{ color: "var(--ws-text)" }}>
            {v2.live
              ? COPY.live
              : v2.status === "DISCARDED"
                ? COPY.discarded
                : COPY.createdPaused}
          </p>
          {v2.live && v2.endsAt ? (
            <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {COPY.liveUntil(
                new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
                  new Date(v2.endsAt),
                ),
              )}
            </p>
          ) : null}
        </div>
      ) : v2 && v2.status === "FAILED" ? (
        <div className="space-y-0.5 text-sm" role="status">
          <p style={{ color: "var(--ws-text)" }}>{COPY.stopped}</p>
          {v2.message ? (
            <p className="text-xs break-words" style={{ color: "var(--ws-text-2)" }}>
              {v2.message}
            </p>
          ) : null}
        </div>
      ) : chain.complete ? (
        <div className="space-y-0.5 text-sm" role="status">
          <p className="font-medium" style={{ color: "var(--ws-text)" }}>
            {COPY.createdAll}
          </p>
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {COPY.turnOn}
          </p>
        </div>
      ) : chain.stopped ? (
        <p className="text-sm" style={{ color: "var(--ws-text)" }}>
          {COPY.stopped}
        </p>
      ) : idle ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {COPY.stillWorking}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="text-xs"
          style={{ color: "var(--destructive)" }}
        >
          {error}
        </p>
      ) : null}

      <CardActions
        buttons={footer}
        busyId={refreshing ? "launch:refresh" : actions.busyId}
        error={actions.error}
        onAct={onFooter}
      />
    </div>
  );
}
