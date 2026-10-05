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
};

// What the server read about one link's Task (null: no Task yet).
export type ChainTaskFacts = {
  status: string;
  pendingApprovalId?: string;
  // An approval of this Task was declined.
  rejected?: boolean;
  // The newest execution error.
  error?: string | null;
  metaId?: string;
};

const MAX_REASON = 220;

export const CHAIN_COPY = {
  failed: "Meta didn't accept it.",
  cancelled: "It was cancelled.",
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
            reason: clipReason(facts.error?.trim() || CHAIN_COPY.cancelled),
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
