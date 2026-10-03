"use client";

import { CalendarDays, Link2 } from "lucide-react";
import Link from "next/link";

import { integrationsHref } from "@/lib/works/starter-cards";

import { PLAN_PANE_COPY as COPY } from "./copy";

// Under a plan's compact card in the chat: the two places a plan is steered
// from, one tap each.
export function PlanQuickLinks({
  projectId,
  workId,
}: {
  projectId: string;
  workId: string;
}) {
  const link =
    "inline-flex min-h-8 items-center gap-1.5 rounded-md text-xs outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50";
  return (
    <div data-plan-links className="mt-1 flex flex-wrap items-center gap-x-4 px-1">
      <Link
        href={`/projects/${projectId}/takvim`}
        className={link}
        style={{ color: "var(--ws-text-2)" }}
      >
        <CalendarDays aria-hidden className="size-3.5" />
        {COPY.seeCalendar}
      </Link>
      <Link
        href={integrationsHref(projectId, undefined, { fromWorkId: workId })}
        className={link}
        style={{ color: "var(--ws-text-2)" }}
      >
        <Link2 aria-hidden className="size-3.5" />
        {COPY.accounts}
      </Link>
    </div>
  );
}
