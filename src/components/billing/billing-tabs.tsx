import Link from "next/link";

import { cn } from "@/lib/utils";

export const BILLING_TABS = [
  { id: "plans", label: "Plans" },
  { id: "subscription", label: "My subscription" },
  { id: "usage", label: "Usage" },
  { id: "tasks", label: "Tasks" },
] as const;

export type BillingTab = (typeof BILLING_TABS)[number]["id"];

export function parseBillingTab(value: string | string[] | undefined): BillingTab {
  const first = Array.isArray(value) ? value[0] : value;
  return BILLING_TABS.find((tab) => tab.id === first)?.id ?? "plans";
}

// Plain links, no client code: the tab is part of the address, so a refresh or a
// shared link lands on the same tab.
export function BillingTabs({ active }: { active: BillingTab }) {
  return (
    <nav
      aria-label="Plan and usage"
      className="flex gap-1 overflow-x-auto border-b"
      style={{ borderColor: "var(--ws-border)" }}
    >
      {BILLING_TABS.map((tab) => (
        <Link
          key={tab.id}
          href={`/billing?tab=${tab.id}`}
          aria-current={active === tab.id ? "page" : undefined}
          className={cn(
            "-mb-px h-9 shrink-0 border-b-2 px-3 text-[13px] leading-9 font-medium",
          )}
          style={{
            borderColor: active === tab.id ? "var(--ws-accent)" : "transparent",
            color: active === tab.id ? "var(--ws-text)" : "var(--ws-text-2)",
          }}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
