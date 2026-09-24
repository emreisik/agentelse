"use client";

import { useActionState, useState } from "react";
import { ImagePlus, Images, Wand2 } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { splitImageIntoGridAction } from "@/server/actions/creative-grid-actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Textarea } from "@/components/ui/textarea";

type State = { ok: true } | { ok: false; message: string } | null;

type SourceOption = {
  assetId: string;
  label: string;
};

// Plain manually-toggled buttons instead of the shared RadioGroup/Select
// primitives on purpose — those are Base UI components with structural
// requirements this codebase has already been bitten by twice this
// session (Menu.GroupLabel needing Menu.Group, Select's popup width
// pinned to its trigger) that aren't worth re-risking for a 2-3-option
// pre-submit toggle with no accessibility complexity beyond a button.
function Toggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium ring-1 transition-colors",
            value === option.value
              ? "bg-primary text-primary-foreground ring-primary"
              : "text-muted-foreground ring-foreground/10 hover:bg-accent",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// Instagram Grid Studio's split panel (spec: izgara) — pick a source
// (an existing recent Instagram-eligible image, or describe one to
// generate fresh — same instant generateCreativeImage() path
// CreativeImageStudio uses, no Task/Approval queue) + a layout, and
// splitImageIntoGridAction does the rest: resize-to-canvas, slice into
// tiles, one Creative per tile, auto-approved.
export function GridSplitStudio({
  projectId,
  recentSources,
  initialPrompt,
}: {
  projectId: string;
  recentSources: SourceOption[];
  initialPrompt?: string;
}) {
  const [mode, setMode] = useState<"existing" | "generate">(
    recentSources.length > 0 && !initialPrompt ? "existing" : "generate",
  );
  const [sourceAssetId, setSourceAssetId] = useState(
    recentSources[0]?.assetId ?? "",
  );
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [layout, setLayout] = useState<"3x1" | "3x3">("3x1");
  const [contentFormat, setContentFormat] = useState<
    "FEED_SQUARE" | "FEED_PORTRAIT"
  >("FEED_SQUARE");

  const previewSrc =
    mode === "existing" && sourceAssetId
      ? `/api/assets/${sourceAssetId}`
      : undefined;
  const { cols, rows } =
    layout === "3x3" ? { cols: 3, rows: 3 } : { cols: 3, rows: 1 };

  const [, formAction] = useActionState(
    async (_prev: State, form: FormData) => {
      const result = await splitImageIntoGridAction(form);
      if (result.ok) {
        toast.success("Grid split created — schedule it below");
      } else {
        toast.error(result.message);
      }
      return result as State;
    },
    null,
  );

  return (
    <form
      action={formAction}
      className="space-y-3 rounded-xl p-3 ring-1 ring-foreground/10"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="layout" value={layout} />
      <input type="hidden" name="contentFormat" value={contentFormat} />
      {mode === "existing" ? (
        <input type="hidden" name="sourceAssetId" value={sourceAssetId} />
      ) : (
        <input type="hidden" name="prompt" value={prompt} />
      )}

      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <Images className="size-4" />
        </span>
        <p className="text-sm font-medium">Split into a grid</p>
      </div>

      {recentSources.length > 0 ? (
        <Toggle
          value={mode}
          onChange={setMode}
          options={[
            { value: "existing", label: "Existing image" },
            { value: "generate", label: "Generate new" },
          ]}
        />
      ) : null}

      {mode === "existing" ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {recentSources.map((source) => (
            <button
              key={source.assetId}
              type="button"
              onClick={() => setSourceAssetId(source.assetId)}
              title={source.label}
              className={cn(
                "shrink-0 overflow-hidden rounded-md ring-2 transition-colors",
                sourceAssetId === source.assetId
                  ? "ring-primary"
                  : "ring-transparent hover:ring-foreground/20",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/assets/${source.assetId}`}
                alt=""
                className="size-14 object-cover"
              />
            </button>
          ))}
        </div>
      ) : (
        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
          placeholder="What should the source image look like? e.g. premium product shot, dark background, soft side lighting"
        />
      )}

      <div className="flex flex-wrap items-center gap-4">
        <div className="space-y-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            Layout
          </span>
          <Toggle
            value={layout}
            onChange={setLayout}
            options={[
              { value: "3x1", label: "3 across" },
              { value: "3x3", label: "3×3 (9 tiles)" },
            ]}
          />
        </div>
        <div className="space-y-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            Tile format
          </span>
          <Toggle
            value={contentFormat}
            onChange={setContentFormat}
            options={[
              { value: "FEED_SQUARE", label: "Square (1:1)" },
              { value: "FEED_PORTRAIT", label: "Portrait (4:5)" },
            ]}
          />
        </div>
      </div>

      {previewSrc ? (
        <div>
          <p className="mb-1 text-[11px] text-muted-foreground">
            Cut lines preview
          </p>
          <div
            className="grid aspect-square w-full max-w-56 overflow-hidden rounded-md border border-border sm:aspect-auto"
            style={{
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gridTemplateRows: `repeat(${rows}, 1fr)`,
              aspectRatio: `${cols} / ${rows}`,
            }}
          >
            {Array.from({ length: cols * rows }, (_, i) => (
              <div
                key={i}
                className="overflow-hidden ring-1 ring-background"
                style={{
                  backgroundImage: `url(${previewSrc})`,
                  backgroundSize: `${cols * 100}% ${rows * 100}%`,
                  backgroundPosition: `${(i % cols) * (100 / (cols - 1 || 1))}% ${Math.floor(i / cols) * (100 / (rows - 1 || 1))}%`,
                }}
              />
            ))}
          </div>
        </div>
      ) : null}

      <SubmitButton
        size="sm"
        disabled={mode === "existing" ? !sourceAssetId : !prompt.trim()}
      >
        {mode === "generate" ? (
          <Wand2 className="size-4" />
        ) : (
          <ImagePlus className="size-4" />
        )}
        Split into {cols * rows} posts
      </SubmitButton>
    </form>
  );
}
