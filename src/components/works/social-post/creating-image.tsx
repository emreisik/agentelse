"use client";

import { useImageProgress } from "@/components/assistant-ui/image-generation-preview";
import { previewBlurPx, type ImageGenState } from "@/lib/image-progress";

export const CREATING_IMAGE_COPY = {
  label: "Creating image",
} as const;

// A plan piece's picture while it is being made, the way ChatGPT shows it: a
// quiet sheen over the empty frame, the streamed preview sharpening in place,
// and one small "Creating image 23%" chip. Fills its positioned parent.
export function CreatingImage({
  state,
  previewUrl,
}: {
  state: ImageGenState;
  previewUrl?: string;
}) {
  const { pct } = useImageProgress(state);
  return (
    <span
      role="progressbar"
      aria-label={CREATING_IMAGE_COPY.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="absolute inset-0 overflow-hidden"
    >
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a streamed data URL preview
        <img
          src={previewUrl}
          alt=""
          aria-hidden
          className="absolute inset-0 size-full scale-110 object-cover transition-[filter] duration-700"
          style={{ filter: `blur(${previewBlurPx(pct)}px)` }}
        />
      ) : null}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1/2 animate-[shimmer_2.8s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-[color-mix(in_oklab,var(--ws-surface)_60%,transparent)] to-transparent motion-reduce:animate-none"
      />
      <span
        className="absolute bottom-2.5 left-2.5 inline-flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1.5 text-[11px] font-medium backdrop-blur-sm"
        style={{
          background: "color-mix(in oklab, var(--ws-surface) 85%, transparent)",
          color: "var(--ws-text-2)",
          boxShadow: "var(--ws-card-shadow)",
        }}
      >
        <ProgressRing pct={pct} />
        {CREATING_IMAGE_COPY.label}
        <span className="tabular-nums" style={{ color: "var(--ws-text-3)" }}>
          {pct}%
        </span>
      </span>
    </span>
  );
}

function ProgressRing({ pct }: { pct: number }) {
  const radius = 5.5;
  const length = 2 * Math.PI * radius;
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-3.5 -rotate-90">
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.2}
        strokeWidth={1.75}
      />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - pct / 100)}
        className="transition-[stroke-dashoffset] duration-300 ease-out"
      />
    </svg>
  );
}
