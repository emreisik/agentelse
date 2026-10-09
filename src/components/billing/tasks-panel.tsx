import Link from "next/link";
import { Hourglass, Pause, Play } from "lucide-react";

import { timeAgo } from "@/lib/dates";
import type {
  ApprovalRow,
  TaskRow,
  TasksOverview,
} from "@/server/billing/overview";

const muted = { color: "var(--ws-text-2)" } as const;
const faint = { color: "var(--ws-text-3)" } as const;

function List({
  title,
  hint,
  icon,
  empty,
  children,
}: {
  title: string;
  hint?: string;
  icon: React.ReactNode;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span style={muted}>{icon}</span>
        <h3
          className="font-heading text-sm font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          {title}
        </h3>
        <span className="text-xs" style={faint}>
          {children.length}
        </span>
      </div>
      {hint ? (
        <p className="-mt-1.5 text-xs" style={faint}>
          {hint}
        </p>
      ) : null}
      {children.length > 0 ? (
        <ul
          className="overflow-hidden rounded-[13px] border"
          style={{ borderColor: "var(--ws-border)" }}
        >
          {children}
        </ul>
      ) : (
        <p className="text-xs" style={faint}>
          {empty}
        </p>
      )}
    </section>
  );
}

function Item({
  first,
  title,
  meta,
  note,
  href,
}: {
  first: boolean;
  title: string;
  meta: string;
  note?: string;
  href: string;
}) {
  return (
    <li
      className="flex items-center justify-between gap-3 px-4 py-2.5"
      style={{ borderTop: first ? undefined : "1px solid var(--ws-border)" }}
    >
      <div className="min-w-0">
        <Link
          href={href}
          className="block truncate text-[13px] font-medium hover:underline"
          style={{ color: "var(--ws-text)" }}
        >
          {title}
        </Link>
        <div className="text-xs" style={faint}>
          {meta}
        </div>
      </div>
      {note ? (
        <span className="shrink-0 text-xs" style={muted}>
          {note}
        </span>
      ) : null}
    </li>
  );
}

const projectHref = (projectId: string) => `/projects/${projectId}`;

const PAUSED_NOTE: Record<NonNullable<TaskRow["pausedFor"]>, string> = {
  allowance: "Allowance used up",
  "no-plan": "Needs a plan",
  "held-back": "Automatic work limit",
};

const PAUSED_HINT =
  "These are waiting for plan allowance. They continue by themselves when it renews or you add more, most important first.";

// Automatic work has its own share of the plan: say it in a percentage, and that
// what the person starts is never held back.
function pausedHint(sharePct: number | undefined): string {
  return sharePct
    ? `${PAUSED_HINT} Automatic work is limited to ${sharePct}% of your plan; your own requests are not affected.`
    : PAUSED_HINT;
}

const taskItem = (row: TaskRow, index: number, note?: string) => (
  <Item
    key={row.id}
    first={index === 0}
    title={row.title}
    meta={`${row.projectName} · ${timeAgo(row.at)}`}
    note={note}
    href={projectHref(row.projectId)}
  />
);

const approvalItem = (row: ApprovalRow, index: number) => (
  <Item
    key={row.id}
    first={index === 0}
    title={row.title}
    meta={`${row.projectName} · ${timeAgo(row.at)}`}
    note="Review"
    href={projectHref(row.projectId)}
  />
);

export function TasksPanel({ tasks }: { tasks: TasksOverview }) {
  return (
    <div className="flex flex-col gap-8">
      <List
        title="Waiting for your approval"
        hint="Nothing here runs until you approve it."
        icon={<Hourglass className="size-4" />}
        empty="Nothing is waiting for you."
      >
        {tasks.awaitingApproval.map(approvalItem)}
      </List>
      <List
        title="Paused"
        hint={pausedHint(tasks.backgroundSharePct)}
        icon={<Pause className="size-4" />}
        empty="Nothing is paused."
      >
        {tasks.paused.map((row, index) =>
          taskItem(row, index, PAUSED_NOTE[row.pausedFor ?? "allowance"]),
        )}
      </List>
      <List
        title="Running now"
        icon={<Play className="size-4" />}
        empty="Nothing is running right now."
      >
        {tasks.active.map((row, index) => taskItem(row, index))}
      </List>
    </div>
  );
}
