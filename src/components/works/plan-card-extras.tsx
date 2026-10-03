"use client";

import { toast } from "sonner";

import { CardActions } from "@/components/works/card-actions";
import { useCardAction } from "@/components/works/use-card-action";
import {
  disabledReasonOf,
  type WorkCardHostValue,
} from "@/components/works/work-card-host";
import { blocksOf, type BrandFlag } from "@/lib/works/brand-rules";
import type { CardActionResult, CardButton } from "@/lib/works/card-action";
import { brandCheckText, copyText } from "@/lib/works/copy";
import { saveContentPlanAction } from "@/server/actions/content-plan-actions";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// The plan pane's brand check (flags on posts, "Save anyway" for a block) and
// the reading of the "More ideas" reply (docs/works.md). The pane itself is
// components/works/plan-pane/.

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type PlanItem = PlanCard["items"][number];

function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function flagText(flag: BrandFlag): string {
  switch (flag.kind) {
    case "never-term":
      return copyText("brand.flag.never", {
        matched: flag.matched,
        rule: flag.rule ?? flag.matched,
      });
    case "preset":
      return copyText("brand.flag.preset", { rule: flag.rule ?? flag.matched });
    case "figure":
      return copyText("brand.flag.figure", { matched: flag.matched });
    case "absolute":
      return copyText("brand.flag.absolute", { matched: flag.matched });
  }
}

function Chip({ flag }: { flag: BrandFlag }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
    >
      {copyText(
        flag.severity === "block" ? "brand.chip.block" : "brand.chip.warn",
      )}
    </span>
  );
}

function FlagLines({
  entries,
}: {
  entries: { index: number; item: PlanItem; flags: BrandFlag[] }[];
}) {
  return (
    <ul className="space-y-2">
      {entries.map(({ index, item, flags }) => (
        <li key={index} className="space-y-1">
          <p
            className="text-xs font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            {`${formatDay(item.date)} · ${item.topic}`}
          </p>
          {flags.map((flag, i) => (
            <p
              key={i}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
              style={{ color: "var(--ws-text-2)" }}
            >
              <span>{flagText(flag)}</span>
              <Chip flag={flag} />
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

const SAVE_ANYWAY: CardButton = {
  id: "brand:save-anyway",
  label: copyText("brand.saveAnyway"),
  emphasis: "secondary",
  action: { kind: "server", id: "brand:save-anyway" },
};

export function BrandCheck({
  card,
  commandId,
  host,
}: {
  card: PlanCard;
  commandId?: string;
  host: WorkCardHostValue;
}) {
  const { run, busyId, error } = useCardAction({
    server: async (): Promise<CardActionResult> => {
      if (!commandId) return { ok: false, message: copyText("kit.failed") };
      const result = await saveContentPlanAction(commandId, {
        allowIssues: true,
      });
      if (!result.ok) {
        return { ok: false, message: result.message, code: result.code };
      }
      // The action revalidates the page: no router.refresh here.
      toast.success(
        copyText("plan.savedToast", { n: result.saved ?? card.items.length }),
      );
      return { ok: true };
    },
  });

  const flagged = card.items.flatMap((item, index) =>
    !item.removed && item.brandFlags && item.brandFlags.length > 0
      ? [{ index, item, flags: item.brandFlags }]
      : [],
  );
  const blocked = flagged.filter((entry) => blocksOf(entry.flags).length > 0);
  const warnOnly = flagged.filter(
    (entry) => blocksOf(entry.flags).length === 0,
  );
  const check = card.brandCheck;
  if (flagged.length === 0 && !check) return null;

  const reason = disabledReasonOf(host, {
    kind: "server",
    planId: commandId,
  });

  return (
    <section data-brand-check className="space-y-2">
      {flagged.length > 0 ? (
        <h4 className="text-sm font-medium" style={{ color: "var(--ws-text)" }}>
          {copyText("brand.heading")}
        </h4>
      ) : null}
      {blocked.length > 0 ? (
        <div className="space-y-2" data-brand-blocks>
          <p className="text-xs" style={{ color: "var(--ws-text)" }}>
            {copyText("brand.blockedNote")}
          </p>
          <FlagLines entries={blocked} />
          {card.state === "draft" ? (
            <CardActions
              buttons={[SAVE_ANYWAY]}
              onAct={run}
              busyId={busyId}
              error={error}
              disabledAll={reason !== null || !commandId}
              disabledReason={reason}
            />
          ) : null}
        </div>
      ) : null}
      {warnOnly.length > 0 ? (
        <details className="rounded-lg border px-2.5" data-brand-warn>
          <summary
            className="flex min-h-11 cursor-pointer items-center text-xs font-medium"
            style={{ color: "var(--ws-text-2)" }}
          >
            {warnOnly.length === 1
              ? copyText("brand.summary.one")
              : copyText("brand.summary.many", { n: warnOnly.length })}
          </summary>
          <div className="pb-2.5">
            <FlagLines entries={warnOnly} />
          </div>
        </details>
      ) : null}
      {check ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {brandCheckText(check)}
        </p>
      ) : null}
    </section>
  );
}

type AlternativesReply =
  { ok: true } | { ok: false; code?: string; message?: string };

export function parseReply(value: unknown): AlternativesReply | null {
  if (!value || typeof value !== "object") return null;
  const data = value as { ok?: unknown; code?: unknown; message?: unknown };
  if (data.ok === true) return { ok: true };
  if (data.ok !== false) return null;
  return {
    ok: false,
    code: typeof data.code === "string" ? data.code : undefined,
    message: typeof data.message === "string" ? data.message : undefined,
  };
}

export function replyFailure(reply: AlternativesReply | null): {
  code: string;
  message: string;
} {
  if (!reply || reply.ok) {
    return { code: "FAILED", message: copyText("planAlt.failed") };
  }
  switch (reply.code) {
    case "MOCK":
      return { code: "MOCK", message: copyText("planAlt.mock") };
    case "BUSY":
      return { code: "BUSY", message: copyText("planAlt.busy") };
    case "LIMIT_RUNS":
      return { code: "LIMIT_RUNS", message: copyText("planAlt.limit") };
    case "NOTHING":
      return { code: "NOTHING", message: copyText("planAlt.nothingLeft") };
    case "BUDGET":
      return {
        code: "BUDGET",
        message: reply.message ?? copyText("planAlt.failed"),
      };
    default:
      return { code: "FAILED", message: copyText("planAlt.failed") };
  }
}
