// The launch chain on the Ads Manager card's Launch step: Campaign -> Ad set ->
// Ad, each its own Meta Task behind its own approval (the existing relays plan
// the next link once the one before it is created). The server reads the
// facts of each link's Task; this decides what the card says about it. Pure.

export const CHAIN_LINKS = ["campaign", "adset", "ad"] as const;
export type ChainLinkKey = (typeof CHAIN_LINKS)[number];

export type ChainLinkState =
  // The link before it is not created yet.
  | "waiting"
  // The link before it is created; this one's Task is on its way.
  | "preparing"
  // Waiting for the person's approval.
  | "approval"
  // Approved: being created in Meta.
  | "running"
  | "created"
  | "failed"
  | "declined"
  // A link before it failed or was declined: it will not be made.
  | "blocked";

export type ChainLink = {
  key: ChainLinkKey;
  state: ChainLinkState;
  approvalId?: string;
  reason?: string;
  // The Meta id once created (campaign id, ad set id, ad id).
  metaId?: string;
};

export type AdsChain = {
  links: ChainLink[];
  complete: boolean;
  // A link failed or was declined: nothing more will happen on its own.
  stopped: boolean;
  campaignId?: string;
  // Güvenli lansman v2 (docs/meta-ads-plan.md F3): tek onay, tek kayıt.
  v2?: LaunchSummary;
};

export type LaunchSummary = {
  launchId: string;
  status: string;
  // Meta'da açık (teslimat başlayabilir).
  live: boolean;
  canRetry: boolean;
  canDiscard: boolean;
  canTurnOn: boolean;
  // Hesap saatiyle bitiş (geri okunmuş ya da hesaplanmış), ISO.
  endsAt?: string;
  verified?: boolean;
  message?: string;
};

// Bir lansmanın kaydından okunanlar (sunucu doldurur).
export type LaunchFacts = {
  launchId: string;
  status: string;
  progress: {
    campaign?: string;
    adSets?: Record<string, string>;
    ads?: Record<string, string>;
    endTime?: number;
    verified?: { ok: boolean };
  };
  adSetCount: number;
  adCount: number;
  pendingApprovalId?: string;
  // Görevin onayı reddedildi.
  declined?: boolean;
  error?: { step: string; message: string } | null;
};

const LAUNCH_RUNNING = new Set(["CREATING", "ACTIVATING", "DISCARDING"]);
const LAUNCH_DONE = new Set(["ACTIVE", "CREATED_PAUSED"]);
const LAUNCH_STOPPED = new Set(["FAILED", "DISCARDED", "CANCELLED", "EXPIRED"]);

function failedAt(error: LaunchFacts["error"], key: ChainLinkKey): boolean {
  if (!error) return false;
  const step = error.step;
  if (key === "campaign") {
    return step === "campaign" || step.startsWith("image") || step.startsWith("creative") || step === "account" || step === "spec" || step === "create";
  }
  if (key === "adset") return step.startsWith("adset");
  return step.startsWith("ad:") || step === "verify" || step === "activate";
}

// Lansman kaydı → kartın üç halkası (Campaign, Ad set, Ad) + özet. Saf.
export function chainFromLaunch(facts: LaunchFacts): AdsChain {
  const created = {
    campaign: Boolean(facts.progress.campaign),
    adset: Object.keys(facts.progress.adSets ?? {}).length >= facts.adSetCount,
    ad: Object.keys(facts.progress.ads ?? {}).length >= facts.adCount,
  };
  const running = LAUNCH_RUNNING.has(facts.status) || (facts.status === "AWAITING_APPROVAL" && !facts.pendingApprovalId && !facts.declined);
  const failed = facts.status === "FAILED";
  const links: ChainLink[] = [];
  let before: ChainLinkState | "launched" = "launched";
  for (const key of CHAIN_LINKS) {
    let link: ChainLink;
    if (created[key]) {
      link = { key, state: "created", ...(key === "campaign" && facts.progress.campaign ? { metaId: facts.progress.campaign } : {}) };
    } else if (failed && failedAt(facts.error, key)) {
      link = { key, state: "failed", reason: clipReason(facts.error?.message ?? CHAIN_COPY.failed) };
    } else if (before === "failed" || before === "declined" || before === "blocked") {
      link = { key, state: "blocked" };
    } else if (key === "campaign" && facts.declined) {
      link = { key, state: "declined" };
    } else if (key === "campaign" && facts.pendingApprovalId) {
      link = { key, state: "approval", approvalId: facts.pendingApprovalId };
    } else if (running && (before === "launched" || before === "created")) {
      link = { key, state: "running" };
    } else {
      link = { key, state: before === "launched" || before === "created" ? "preparing" : "waiting" };
    }
    links.push(link);
    before = link.state;
  }
  const live = facts.status === "ACTIVE";
  const endsAt = facts.progress.endTime ? new Date(facts.progress.endTime * 1000).toISOString() : undefined;
  return {
    links,
    complete: LAUNCH_DONE.has(facts.status),
    stopped: LAUNCH_STOPPED.has(facts.status) || Boolean(facts.declined),
    ...(facts.progress.campaign ? { campaignId: facts.progress.campaign } : {}),
    v2: {
      launchId: facts.launchId,
      status: facts.status,
      live,
      canRetry: failed,
      canDiscard: failed || facts.status === "CREATED_PAUSED",
      canTurnOn: facts.status === "CREATED_PAUSED",
      ...(endsAt ? { endsAt } : {}),
      ...(facts.progress.verified ? { verified: facts.progress.verified.ok } : {}),
      ...(facts.error?.message ? { message: clipReason(facts.error.message) } : {}),
    },
  };
}

// What the server read about one link's Task (null: no Task yet).
export type ChainTaskFacts = {
  status: string;
  pendingApprovalId?: string;
  // An approval of this Task was declined.
  rejected?: boolean;
  // Its approval ran out (72 h for Meta spend, docs/meta-ads-plan.md F0b).
  expired?: boolean;
  // The newest execution error.
  error?: string | null;
  metaId?: string;
};

const MAX_REASON = 220;

export const CHAIN_COPY = {
  failed: "Meta didn't accept it.",
  cancelled: "It was cancelled.",
  expired:
    "The approval ran out after 72 hours. Launch again to approve it with today's numbers.",
} as const;

function clipReason(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_REASON
    ? flat
    : `${flat.slice(0, MAX_REASON - 1).trimEnd()}…`;
}

function linkOf(
  key: ChainLinkKey,
  facts: ChainTaskFacts | null,
  before: ChainLinkState | "launched",
): ChainLink {
  if (!facts) {
    if (before === "failed" || before === "declined" || before === "blocked") {
      return { key, state: "blocked" };
    }
    return {
      key,
      state:
        before === "launched" || before === "created" ? "preparing" : "waiting",
    };
  }
  switch (facts.status) {
    case "COMPLETED":
      return {
        key,
        state: "created",
        ...(facts.metaId ? { metaId: facts.metaId } : {}),
      };
    case "FAILED":
      return {
        key,
        state: "failed",
        reason: clipReason(facts.error?.trim() || CHAIN_COPY.failed),
      };
    case "CANCELLED":
      return facts.rejected
        ? { key, state: "declined" }
        : {
            key,
            state: "failed",
            reason: clipReason(
              facts.error?.trim() ||
                (facts.expired ? CHAIN_COPY.expired : CHAIN_COPY.cancelled),
            ),
          };
    case "WAITING_APPROVAL":
      return facts.pendingApprovalId
        ? { key, state: "approval", approvalId: facts.pendingApprovalId }
        : { key, state: "running" };
    default:
      return { key, state: "running" };
  }
}

// The three links in order, from the facts of their Tasks.
export function chainOf(
  facts: readonly [
    ChainTaskFacts | null,
    ChainTaskFacts | null,
    ChainTaskFacts | null,
  ],
): AdsChain {
  const links: ChainLink[] = [];
  let before: ChainLinkState | "launched" = "launched";
  CHAIN_LINKS.forEach((key, index) => {
    const link = linkOf(key, facts[index] ?? null, before);
    links.push(link);
    before = link.state;
  });
  const stopped = links.some(
    (link) => link.state === "failed" || link.state === "declined",
  );
  const campaignId = links[0]?.metaId;
  return {
    links,
    complete: links[2]?.state === "created",
    stopped,
    ...(campaignId ? { campaignId } : {}),
  };
}

// Meta is still working on a link (worth reading again soon); waiting for the
// person is not: nothing moves until they approve.
export function isChainMoving(chain: AdsChain): boolean {
  if (chain.v2 && ["CREATING", "ACTIVATING", "DISCARDING"].includes(chain.v2.status)) {
    return true;
  }
  if (chain.complete || chain.stopped) return false;
  return chain.links.some(
    (link) => link.state === "running" || link.state === "preparing",
  );
}

// The link waiting for the person's approval, if any (one at a time).
export function approvalLinkOf(chain: AdsChain): ChainLink | undefined {
  return chain.links.find(
    (link) => link.state === "approval" && link.approvalId,
  );
}
