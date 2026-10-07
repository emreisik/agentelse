import "server-only";

import { SeoActionFlags, seoActionsAllowedFor } from "@/lib/seo/action-flags";
import {
  FIX_INSTRUCTIONS,
  FIX_KIND_LABEL,
  ACTION_STATUS_LABEL,
  actionTitle,
  askText,
  outcomeDetail,
  outcomeHeadline,
  proposalLines,
} from "@/lib/seo/actions/copy";
import type {
  SeoActionStatus,
  SeoActionView,
  SeoFixKind,
} from "@/lib/seo/actions/types";
import { seoMockMode } from "@/lib/seo/health-flags";
import { maskGooglePath } from "@/server/integrations/google/pii";
import { listActions } from "@/server/seo/actions/store";
import { primaryGscLink } from "@/server/seo/store";

// Search sayfasındaki "Actions & results" bölümünün verisi (SC-F6,
// docs/search-actions.md "Arayüz"). SEO_ACTIONS (+ SEO_HEALTH + SEO_CRAWL) ya da
// açılış listesi kapalıyken veritabanına hiç gitmez. Etiketler sabit
// İngilizcedir; sonuç metinleri şablondur (Google sayıları üzerinde anlatı
// üretilmez). Teklif satırlarına Google'dan gelen anahtar kelime girmez.

export type ActionTone = "positive" | "negative" | "neutral" | "waiting";

export type SeoActionItem = {
  id: string;
  kind: SeoFixKind;
  kindLabel: string;
  status: SeoActionStatus;
  statusLabel: string;
  tone: ActionTone;
  // "Title and description · /pricing"
  title: string;
  // Sorgu dizesiz, maskeli, ≤ 60 karakter; hedef yoksa null.
  targetPath: string | null;
  proposalLines: string[];
  // Kartı olmayan, henüz uygulanmamış eylemin kontrol listesi.
  instructions: string[] | null;
  checks: { label: string; ok: boolean }[];
  headline: string | null;
  detail: string | null;
  // "Waiting for Google ..." gibi durum notu.
  note: string | null;
  // Doğrulanamayan eylemde kullanıcıya sorulan soru.
  ask: string | null;
  cardHref: string | null;
  can: {
    apply: boolean;
    undo: boolean;
    dismiss: boolean;
    confirmLive: boolean;
    checkNow: boolean;
  };
  highlighted: boolean;
};

export type SeoActionsPanel = {
  projectId: string;
  searchConnected: boolean;
  needsYou: SeoActionItem[];
  inProgress: SeoActionItem[];
  results: SeoActionItem[];
  counts: {
    needsYou: number;
    inProgress: number;
    worked: number;
    didnt: number;
    inconclusive: number;
  };
};

const RESULT_WINDOW_DAYS = 180;
const RESULT_LIMIT = 20;
const OPEN_LIMIT = 100;
const PATH_MAX = 60;
const DAY_MS = 86_400_000;

const OPEN_STATUSES: readonly SeoActionStatus[] = [
  "PROPOSED",
  "ACCEPTED",
  "APPLIED",
  "VERIFIED",
  "EVALUATING",
];
const RESULT_STATUSES: readonly SeoActionStatus[] = [
  "WORKED",
  "DIDNT",
  "INCONCLUSIVE",
];
// Tarayıcımızın kendi başına bakamadığı durumlar: kullanıcı "It's live" der.
const MANUAL_REASONS: ReadonlySet<string> = new Set([
  "NO_SITE",
  "ROBOTS",
  "OUT_OF_SCOPE",
]);

const NOTE = {
  checking: "Agentelse is checking your public page.",
  manual: "We can't check this page ourselves. Tell us when it's live.",
  waitingGoogle: "Live on your site. Waiting for Google to recrawl it.",
} as const;

const TONE: Readonly<Record<SeoActionStatus, ActionTone>> = {
  PROPOSED: "waiting",
  ACCEPTED: "waiting",
  APPLIED: "waiting",
  VERIFIED: "waiting",
  EVALUATING: "waiting",
  WORKED: "positive",
  DIDNT: "negative",
  INCONCLUSIVE: "neutral",
  DISMISSED: "neutral",
  EXPIRED: "neutral",
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Sorgu dizesi ve parça atılır, kişisel veri maskelenir, 60 karaktere kısalır.
export function cleanPath(url: string | null): string | null {
  if (!url) return null;
  let pathname: string;
  try {
    pathname = new URL(url).pathname || "/";
  } catch {
    return null;
  }
  const masked = maskGooglePath(pathname) || "/";
  return masked.length > PATH_MAX
    ? `${masked.slice(0, PATH_MAX - 1)}…`
    : masked;
}

function pathLabel(url: string): string {
  return cleanPath(url) ?? "/";
}

function workHref(projectId: string, workId: string): string {
  return `/projects/${projectId}?work=${encodeURIComponent(workId)}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function noteFor(action: SeoActionView, manual: boolean): string | null {
  switch (action.status) {
    case "APPLIED":
      return manual ? NOTE.manual : NOTE.checking;
    case "VERIFIED":
      return NOTE.waitingGoogle;
    case "EVALUATING":
      return action.evaluateAfter
        ? `Measuring. Results expected around ${DATE_FORMAT.format(action.evaluateAfter)}.`
        : "Measuring.";
    default:
      return null;
  }
}

export function itemOf(
  action: SeoActionView,
  highlight: string | null,
): SeoActionItem {
  const hasCard = action.commandId !== null && action.workId !== null;
  const manual =
    action.status === "APPLIED" &&
    action.verification.reason !== null &&
    MANUAL_REASONS.has(action.verification.reason);
  const asked = action.status === "APPLIED" && action.askedAt !== null;
  const targetPath = cleanPath(action.targetUrl);
  const evaluation = action.evaluation;
  const openChecklist =
    !hasCard && (action.status === "PROPOSED" || action.status === "ACCEPTED");
  return {
    id: action.id,
    kind: action.kind,
    kindLabel: FIX_KIND_LABEL[action.kind],
    status: action.status,
    statusLabel: ACTION_STATUS_LABEL[action.status],
    tone: TONE[action.status],
    title: actionTitle(action.kind, targetPath),
    targetPath,
    proposalLines: proposalLines(action.proposal, pathLabel),
    instructions: openChecklist ? [...FIX_INSTRUCTIONS[action.kind]] : null,
    checks: action.verification.checks.map((check) => ({
      label: check.label,
      ok: check.ok,
    })),
    headline: evaluation ? outcomeHeadline(evaluation) : null,
    detail: evaluation ? outcomeDetail(evaluation) : null,
    note: noteFor(action, manual),
    ask: asked ? askText(action.kind) : null,
    cardHref:
      hasCard && action.workId
        ? workHref(action.projectId, action.workId)
        : null,
    can: {
      apply:
        action.status === "ACCEPTED" ||
        (action.status === "PROPOSED" && !hasCard),
      undo: action.status === "APPLIED",
      dismiss: action.status === "PROPOSED" || action.status === "ACCEPTED",
      confirmLive: asked || manual,
      checkNow: action.status === "APPLIED" || action.status === "VERIFIED",
    },
    highlighted: highlight !== null && action.id === highlight,
  };
}

function resultStamp(action: SeoActionView): number {
  return (action.evaluatedAt ?? action.updatedAt).getTime();
}

function highlightId(value: string | null | undefined): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

export async function loadSeoActionsPanel(
  projectId: string,
  options: { now?: Date; highlight?: string | null } = {},
): Promise<SeoActionsPanel | null> {
  // Bayraklar ve izin listesi yalnız ortamdan okunur: kapalıyken sorgu yok.
  if (!SeoActionFlags.loop() || !seoActionsAllowedFor(projectId)) return null;
  const now = options.now ?? new Date();
  const highlight = highlightId(options.highlight);
  const since = new Date(now.getTime() - RESULT_WINDOW_DAYS * DAY_MS);

  const [open, evaluated, link] = await Promise.all([
    listActions(projectId, { statuses: OPEN_STATUSES, limit: OPEN_LIMIT }),
    listActions(projectId, {
      statuses: RESULT_STATUSES,
      since,
      limit: RESULT_LIMIT * 2,
    }),
    primaryGscLink(projectId),
  ]);

  const needsYou: SeoActionItem[] = [];
  const inProgress: SeoActionItem[] = [];
  for (const action of open) {
    const hasCard = action.commandId !== null;
    const asked = action.status === "APPLIED" && action.askedAt !== null;
    if (action.status === "ACCEPTED" || asked) {
      needsYou.push(itemOf(action, highlight));
    } else if (
      action.status === "APPLIED" ||
      action.status === "VERIFIED" ||
      action.status === "EVALUATING" ||
      // Kartı olmayan öneri bu sayfada yürür; kartı olan kartında sürer.
      (action.status === "PROPOSED" && !hasCard)
    ) {
      inProgress.push(itemOf(action, highlight));
    }
  }

  const results = evaluated
    .filter((action) => resultStamp(action) >= since.getTime())
    .sort((a, b) => resultStamp(b) - resultStamp(a))
    .slice(0, RESULT_LIMIT)
    .map((action) => itemOf(action, highlight));

  return {
    projectId,
    searchConnected: link !== null && link.isMock === seoMockMode(),
    needsYou,
    inProgress,
    results,
    counts: {
      needsYou: needsYou.length,
      inProgress: inProgress.length,
      worked: results.filter((item) => item.status === "WORKED").length,
      didnt: results.filter((item) => item.status === "DIDNT").length,
      inconclusive: results.filter((item) => item.status === "INCONCLUSIVE")
        .length,
    },
  };
}
