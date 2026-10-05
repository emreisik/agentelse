"use client";

import { useEffect, useState, type FC } from "react";
import { CheckCircle2 } from "lucide-react";

import {
  imageProgress,
  previewBlurPx,
  type ImageGenState,
} from "@/lib/image-progress";

// The 0-100% of a render in progress, ticking on its own between milestones
// (see imageProgress). Also drives the plan posts' "Creating image" state.
export function useImageProgress(state: ImageGenState): {
  pct: number;
  label: string;
} {
  const [running, setRunning] = useState(() =>
    imageProgress(state, Date.now()),
  );

  useEffect(() => {
    if (state.done) return undefined;
    const id = setInterval(() => {
      setRunning((previous) => imageProgress(state, Date.now(), previous.pct));
    }, 250);
    return () => clearInterval(id);
  }, [state]);

  // Derived at render so completion shows instantly, not on the next tick.
  return state.done ? { pct: 100, label: "Done" } : running;
}

// The live "image is being made" block in the chat (CHAT_ENGINE=agent's
// generate_image): a blurred preview that sharpens as streamed previews
// arrive, with an explicit 0-100% bar and the current stage. 100% appears
// only when the render is really finished; the finished card then replaces
// this block.
export const ImageGenerationPreview: FC<{
  state: ImageGenState;
  previewUrl?: string;
}> = ({ state, previewUrl }) => {
  const view = useImageProgress(state);

  return (
    <div
      role="progressbar"
      aria-label="Image generation progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={view.pct}
      className="bg-muted relative mb-2 aspect-[4/5] w-full max-w-sm overflow-hidden rounded-2xl border"
    >
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewUrl}
          alt="Image being generated"
          className="absolute inset-0 size-full scale-105 object-cover transition-[filter] duration-500"
          style={{ filter: `blur(${previewBlurPx(view.pct)}px)` }}
        />
      ) : (
        <div className="from-muted via-background to-muted absolute inset-0 animate-pulse bg-gradient-to-br" />
      )}

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent p-3 pt-10 text-white">
        <div className="flex items-center justify-between text-xs font-medium">
          <span className="flex items-center gap-1.5">
            {state.done ? <CheckCircle2 className="size-3.5" /> : null}
            {view.label}
          </span>
          <span className="tabular-nums">{view.pct}%</span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/25">
          <div
            className="h-full rounded-full bg-white transition-[width] duration-300 ease-out"
            style={{ width: `${view.pct}%` }}
          />
        </div>
      </div>
    </div>
  );
};
