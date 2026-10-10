import { AlertTriangle, ImageIcon, Sparkles } from "lucide-react";

import {
  extraPackCards,
  formatDay,
  limitLevel,
  usedPercent,
} from "@/lib/billing/catalog";
import type {
  AllowanceOverview,
  BillingOverview,
} from "@/server/billing/overview";
import { startPackCheckoutAction } from "@/server/actions/billing-actions";
import { Button } from "@/components/ui/button";

import { BillingActionButton } from "./billing-action-button";
import { UsageBar } from "./usage-bar";

const MODULE_LABEL: Record<string, string> = {
  SOCIAL: "Social Media",
  ADS: "Ads",
  ANALYTICS: "Analytics",
  SEO: "SEO",
  CHAT: "Assistant chat",
  OTHER: "Other",
};

const muted = { color: "var(--ws-text-2)" } as const;
const faint = { color: "var(--ws-text-3)" } as const;

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div>
        <h3
          className="font-heading text-sm font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          {title}
        </h3>
        {hint ? (
          <p className="text-xs" style={faint}>
            {hint}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

const tile = {
  borderColor: "var(--ws-border)",
  background: "var(--ws-surface)",
  boxShadow: "var(--ws-card-shadow)",
} as const;

// The line under the bar: what the end date of the window really means. Never "Renews" for a
// plan that is ending or a date that has passed.
function windowCaption(
  window: AllowanceOverview["window"],
  endsAt: string | null,
): string {
  const day = endsAt ? formatDay(endsAt) : null;
  switch (window) {
    case "ends":
      return day ? `Available until ${day}` : "Ends with your plan";
    case "overdue":
      return "Paused: the renewal payment is overdue";
    case "renewing":
      return "Renewing: the new allowance appears as soon as the payment is recorded";
    case "ended":
      return "Your plan has ended";
    case "trial-ended":
      return "Your free trial has ended. Choose a plan in Plans to keep creating.";
    default:
      return day ? `Renews ${day}` : "No renewal date yet";
  }
}

function AllowanceCard({ allowance }: { allowance: AllowanceOverview }) {
  const isImage = allowance.unit === "IMAGE";
  const windowOpen =
    allowance.window === "renews" || allowance.window === "ends";
  // A window that is over has nothing of its own left: only the extra packs, if any.
  const nothingGranted = !windowOpen && allowance.granted <= 0;
  const level = windowOpen
    ? limitLevel(allowance.granted, allowance.available)
    : "ok";
  const percent = usedPercent(allowance.granted, allowance.available);
  const Icon = isImage ? ImageIcon : Sparkles;
  const title = isImage ? "Post images" : "AI assistant usage";
  const renews = allowance.endsAt ? formatDay(allowance.endsAt) : null;
  const what = isImage ? "post images" : "AI assistant usage";
  const ending = allowance.window === "ends";

  return (
    <div className="flex flex-col gap-3 rounded-[13px] border p-4" style={tile}>
      <div className="flex items-center gap-2">
        <Icon className="size-4" style={muted} />
        <span
          className="text-[13px] font-medium"
          style={{ color: "var(--ws-text)" }}
        >
          {title}
        </span>
      </div>
      <div>
        <div
          className="font-heading text-[26px] leading-none font-semibold tracking-tight"
          style={{ color: "var(--ws-text)" }}
        >
          {isImage
            ? allowance.available
            : nothingGranted
              ? "0%"
              : `${100 - percent}%`}
        </div>
        <p className="mt-1 text-xs" style={muted}>
          {nothingGranted
            ? "left"
            : isImage
              ? `left of ${allowance.granted}`
              : `left this period (${percent}% used)`}
        </p>
      </div>
      <UsageBar
        granted={allowance.granted}
        available={allowance.available}
        label={`${title} used`}
      />
      <p className="text-xs" style={faint}>
        {windowCaption(allowance.window, allowance.endsAt)}
        {allowance.extraAvailable > 0
          ? ` · includes ${isImage ? allowance.extraAvailable : "extra usage you bought"}`
          : ""}
      </p>
      {level !== "ok" ? (
        <div
          className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
          style={{
            background: "var(--ws-surface-2)",
            color:
              level === "out" ? "var(--destructive)" : "var(--ws-text-body)",
          }}
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {level === "out"
              ? ending
                ? `You have used all of your ${what}. Work that needs it waits until you add more; it does not renew because your plan is ending.`
                : `You have used all of your ${what} for this period. Work that needs it waits and continues by itself when it renews or you add more.`
              : ending
                ? `You are running low on ${what}. Add more below; your plan is ending${renews ? ` on ${renews}` : ""}, so it does not renew.`
                : `You are running low on ${what}. Add more below, or it renews${renews ? ` on ${renews}` : " soon"}.`}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function UsagePanel({
  overview,
  packsOpen = false,
  packsNote,
  paymentsOpen = false,
}: {
  overview: BillingOverview;
  // Payments are connected (plans can be bought): changes what the empty state says.
  paymentsOpen?: boolean;
  // Buying extra usage works (payments are connected, the viewer can manage billing
  // and the workspace has a plan).
  packsOpen?: boolean;
  // Why buying is not available right now, when payments are connected.
  packsNote?: string;
}) {
  const { allowances, measured } = overview;
  const since = formatDay(measured.since);

  return (
    <div className="flex flex-col gap-8">
      {allowances.length > 0 ? (
        <Section title="Remaining">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {allowances.map((allowance) => (
              <AllowanceCard key={allowance.unit} allowance={allowance} />
            ))}
          </div>
        </Section>
      ) : (
        <div
          className="rounded-[13px] border px-4 py-3.5 text-[13px]"
          style={{
            borderColor: "var(--ws-border)",
            background: "var(--ws-surface-2)",
            color: "var(--ws-text-body)",
          }}
        >
          <span className="font-medium" style={{ color: "var(--ws-text)" }}>
            {overview.subscription?.paidAccess
              ? "Your plan is active."
              : paymentsOpen
                ? "No plan yet."
                : "Usage is measured, not limited yet."}
          </span>{" "}
          <span style={muted}>
            {overview.subscription?.paidAccess
              ? "Allowances show here once usage limits are switched on. Until then you can see exactly what your brands use below."
              : paymentsOpen
                ? "Choose a plan in Plans to get a monthly allowance. Until then you can see exactly what your brands use below."
                : "Allowances start when plans go on sale. Until then you can see exactly what your brands use below."}
          </span>
        </div>
      )}

      <Section title="This month so far" hint={`Since ${since}`}>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-[13px] border p-4" style={tile}>
            <div
              className="font-heading text-[26px] leading-none font-semibold tracking-tight"
              style={{ color: "var(--ws-text)" }}
            >
              {measured.images}
            </div>
            <p className="mt-1 text-xs" style={muted}>
              pictures created
            </p>
          </div>
          <div className="rounded-[13px] border p-4" style={tile}>
            <div
              className="font-heading text-[26px] leading-none font-semibold tracking-tight"
              style={{ color: "var(--ws-text)" }}
            >
              {measured.aiRequests}
            </div>
            <p className="mt-1 text-xs" style={muted}>
              AI assistant requests
            </p>
          </div>
        </div>

        {measured.byModule.length > 0 ? (
          <ul
            className="overflow-hidden rounded-[13px] border text-[13px]"
            style={{ borderColor: "var(--ws-border)" }}
          >
            {measured.byModule.map((row, index) => (
              <li
                key={row.module}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
                style={{
                  borderTop:
                    index === 0 ? undefined : "1px solid var(--ws-border)",
                  color: "var(--ws-text-body)",
                }}
              >
                <span>{MODULE_LABEL[row.module] ?? row.module}</span>
                <span className="text-xs" style={muted}>
                  {row.images} {row.images === 1 ? "picture" : "pictures"} ·{" "}
                  {row.aiRequests}{" "}
                  {row.aiRequests === 1 ? "request" : "requests"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs" style={faint}>
            Nothing used yet this month.
          </p>
        )}
      </Section>

      <Section title="Last 14 days">
        {measured.daily.length > 0 ? (
          <div
            className="overflow-hidden rounded-[13px] border"
            style={{ borderColor: "var(--ws-border)" }}
          >
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: "var(--ws-surface-2)" }}>
                  <th className="px-4 py-2 text-left font-medium" style={muted}>
                    Day
                  </th>
                  <th
                    className="px-4 py-2 text-right font-medium"
                    style={muted}
                  >
                    Pictures
                  </th>
                  <th
                    className="px-4 py-2 text-right font-medium"
                    style={muted}
                  >
                    AI requests
                  </th>
                </tr>
              </thead>
              <tbody>
                {measured.daily.map((row) => (
                  <tr
                    key={row.day}
                    className="border-t"
                    style={{ borderColor: "var(--ws-border)" }}
                  >
                    <td
                      className="px-4 py-2"
                      style={{ color: "var(--ws-text-body)" }}
                    >
                      {formatDay(`${row.day}T12:00:00.000Z`, { year: false })}
                    </td>
                    <td
                      className="px-4 py-2 text-right tabular-nums"
                      style={{ color: "var(--ws-text-body)" }}
                    >
                      {row.images}
                    </td>
                    <td
                      className="px-4 py-2 text-right tabular-nums"
                      style={{ color: "var(--ws-text-body)" }}
                    >
                      {row.aiRequests}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs" style={faint}>
            No activity in the last 14 days.
          </p>
        )}
      </Section>

      <Section
        title="Add more usage"
        hint="Extra usage is added to your balance and does not expire at renewal."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {extraPackCards().map((pack) => (
            <div
              key={pack.key}
              className="flex items-center justify-between gap-3 rounded-[13px] border p-4"
              style={tile}
            >
              <div>
                <div
                  className="text-[13px] font-medium"
                  style={{ color: "var(--ws-text)" }}
                >
                  {pack.title}
                </div>
                <div className="text-xs" style={muted}>
                  ${(pack.priceCents / 100).toLocaleString("en-US")}
                </div>
              </div>
              {packsOpen ? (
                <BillingActionButton
                  variant="outline"
                  busyLabel="Opening…"
                  action={startPackCheckoutAction}
                  input={{ packKey: pack.key }}
                >
                  Buy
                </BillingActionButton>
              ) : (
                <Button type="button" variant="outline" size="lg" disabled>
                  Buy
                </Button>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs" style={faint}>
          {packsOpen
            ? "Payment is handled by Stripe. The extra usage is added as soon as the payment clears."
            : (packsNote ?? "Buying opens together with plans.")}
        </p>
      </Section>
    </div>
  );
}
