"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import type { CreativeType } from "@prisma/client";

import { CREATIVE_STATUS, SOCIAL_PLATFORM } from "@/lib/labels";
import { OutputPreviewDialog } from "@/components/workspace/output-preview-dialog";
import type { WorkspaceOutputItem } from "./workspace-right-panel-data";

// Spec's filter set is "All / Post / Story / Reel / Ads" — Story/Reel
// come from the latest CreativeVersion's contentFormat (see
// workspace-right-panel-data.ts toOutputItem), Ads from CreativeType,
// and everything else that isn't a Story/Reel/ad falls under Post.
type FilterKey = "all" | "posts" | "story" | "reel" | "ads";

const AD_TYPES = new Set<CreativeType>(["AD_CREATIVE", "CAMPAIGN_BRIEF"]);

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "posts", label: "Post" },
  { key: "story", label: "Story" },
  { key: "reel", label: "Reel" },
  { key: "ads", label: "Ads" },
];

function matchesFilter(output: WorkspaceOutputItem, filter: FilterKey) {
  if (filter === "all") return true;
  if (filter === "ads") return AD_TYPES.has(output.type);
  if (filter === "story") return output.contentFormat === "STORY";
  if (filter === "reel") return output.contentFormat === "REEL";
  // posts: everything that isn't an ad, a Story or a Reel
  return (
    !AD_TYPES.has(output.type) &&
    output.contentFormat !== "STORY" &&
    output.contentFormat !== "REEL"
  );
}

export function OutputsPanel({ outputs }: { outputs: WorkspaceOutputItem[] }) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [previewId, setPreviewId] = useState<string | null>(null);

  const filtered = outputs.filter((output) => matchesFilter(output, filter));

  return (
    <div className="flex flex-col gap-4 px-4 py-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div
            className="text-[10px] font-semibold tracking-[0.1em]"
            style={{ color: "var(--ws-text-3)" }}
          >
            FROM IDEA TO OUTPUT
          </div>
          <div
            className="mt-0.5 text-base font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            Made for your brand.
          </div>
        </div>
        {outputs.length > 0 ? (
          <span
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium"
            style={{
              background: "var(--ws-surface-2)",
              color: "var(--ws-text-2)",
            }}
          >
            {outputs.length}
          </span>
        ) : null}
      </div>

      <div className="scrollbar-none flex gap-1.5 overflow-x-auto pb-0.5">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key)}
            className="shrink-0 rounded-full px-3 py-1 text-[11px] font-medium whitespace-nowrap transition-colors"
            style={
              filter === item.key
                ? {
                    background: "var(--ws-accent)",
                    color: "var(--ws-on-accent)",
                  }
                : {
                    background: "var(--ws-surface-2)",
                    color: "var(--ws-text-2)",
                  }
            }
          >
            {item.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="px-0.5">
          <p className="text-sm" style={{ color: "var(--ws-text)" }}>
            It starts with an idea.
          </p>
          <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
            {outputs.length === 0
              ? "Ask Agentelse to create something."
              : "Nothing in this category yet."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {filtered.map((output) => {
            const isDone =
              output.status === "APPROVED" || output.status === "PUBLISHED";
            return (
              <button
                key={output.id}
                type="button"
                onClick={() => setPreviewId(output.id)}
                className="group flex flex-col overflow-hidden rounded-xl border text-left shadow-[0_1px_3px_rgba(52,75,29,0.04)] transition-transform hover:-translate-y-0.5"
                style={{ borderColor: "var(--ws-border)" }}
              >
                <div
                  className="relative aspect-[4/5] w-full overflow-hidden"
                  style={{ background: "var(--ws-surface-2)" }}
                >
                  {output.assetId ? (
                    // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image can't optimize it
                    <img
                      src={`/api/assets/${output.assetId}`}
                      alt={output.title ?? output.type}
                      className="size-full object-cover transition-transform group-hover:scale-105"
                    />
                  ) : null}
                  {isDone ? (
                    <span
                      className="absolute top-2 right-2 flex size-5 items-center justify-center rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.15)]"
                      style={{ background: "var(--ws-approved)" }}
                      title={CREATIVE_STATUS[output.status].label}
                    >
                      <Check
                        className="size-3"
                        style={{ color: "var(--ws-on-accent)" }}
                        strokeWidth={3}
                      />
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-col gap-0.5 p-3">
                  <span
                    className="text-[10px] font-medium tracking-wide uppercase"
                    style={{ color: "var(--ws-text-3)" }}
                  >
                    {output.platform
                      ? SOCIAL_PLATFORM[output.platform].label
                      : output.type}
                  </span>
                  <span
                    className="truncate text-xs font-medium"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {output.title ?? "Untitled"}
                  </span>
                  <span
                    className="flex items-center gap-1 text-[10px]"
                    style={{ color: "var(--ws-text-3)" }}
                  >
                    {!isDone ? (
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{
                          background:
                            output.status === "IN_REVIEW"
                              ? "var(--ws-pending)"
                              : "var(--ws-text-3)",
                        }}
                      />
                    ) : null}
                    {CREATIVE_STATUS[output.status].label}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <OutputPreviewDialog
        creativeId={previewId}
        onOpenChange={(open) => {
          if (!open) setPreviewId(null);
        }}
      />
    </div>
  );
}
