"use client";

import {
  Eye,
  Heart,
  MousePointerClick,
  ShoppingCart,
  Smartphone,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// The six OUTCOME_* objective values MetaApiProvider/meta-client.ts already
// accept as-is (see createMetaCampaign) — this only changes how the user
// picks one, not the value sent to Meta.
export const OBJECTIVES = [
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_APP_PROMOTION",
  "OUTCOME_SALES",
] as const;

export type Objective = (typeof OBJECTIVES)[number];

const OBJECTIVE_META: Record<
  Objective,
  { icon: LucideIcon; title: string; description: string }
> = {
  OUTCOME_AWARENESS: {
    icon: Eye,
    title: "Awareness",
    description:
      "Show your ads to people most likely to remember them — best for building brand recognition.",
  },
  OUTCOME_TRAFFIC: {
    icon: MousePointerClick,
    title: "Traffic",
    description:
      "Send people to a destination, like your website, app, or a Facebook/Instagram experience.",
  },
  OUTCOME_ENGAGEMENT: {
    icon: Heart,
    title: "Engagement",
    description:
      "Get more messages, video views, post engagement, or Page likes.",
  },
  OUTCOME_LEADS: {
    icon: UserPlus,
    title: "Leads",
    description:
      "Collect leads for your business or brand through forms, calls, or messages.",
  },
  OUTCOME_APP_PROMOTION: {
    icon: Smartphone,
    title: "App promotion",
    description: "Find new people to install your app and keep using it.",
  },
  OUTCOME_SALES: {
    icon: ShoppingCart,
    title: "Sales",
    description:
      "Find people likely to purchase your product or service online or in-store.",
  },
};

export function ObjectivePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: Objective) => void;
}) {
  const selected = OBJECTIVES.find((o) => o === value) ?? OBJECTIVES[1];
  const selectedMeta = OBJECTIVE_META[selected];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as Objective)}
        className="gap-1.5"
      >
        {OBJECTIVES.map((objective) => {
          const meta = OBJECTIVE_META[objective];
          const Icon = meta.icon;
          const isSelected = objective === value;
          return (
            <label
              key={objective}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 transition-colors",
                isSelected
                  ? "bg-primary/5 ring-primary/30"
                  : "ring-foreground/10 hover:bg-muted/50",
              )}
            >
              <RadioGroupItem value={objective} />
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-lg",
                  isSelected
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <Icon className="size-4" strokeWidth={1.75} />
              </span>
              <span className="text-sm font-medium text-foreground">
                {meta.title}
              </span>
            </label>
          );
        })}
      </RadioGroup>
      <div className="hidden w-56 shrink-0 rounded-xl bg-muted/30 p-4 ring-1 ring-foreground/10 sm:block">
        <p className="text-sm font-medium text-foreground">
          {selectedMeta.title}
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {selectedMeta.description}
        </p>
      </div>
    </div>
  );
}
