"use client";

import { FileVideo, ImagePlus } from "lucide-react";

import { useObjectUrl } from "@/lib/use-object-url";

// Two plain file inputs, not react-hook-form fields — same reasoning as the
// single-image step's local `image` state: File isn't a zod-validated text
// field, so both are kept as local state in the wizard and validated
// manually. A thumbnail is required separately from the video itself: Meta's
// video_data creative needs a public image_url cover image
// (createMetaVideoAdCreative in meta-client.ts), and there's no server-side
// video-frame extraction here to derive one automatically.
export function VideoUploadField({
  video,
  onVideoChange,
  thumbnail,
  onThumbnailChange,
  error,
}: {
  video: File | null;
  onVideoChange: (file: File | null) => void;
  thumbnail: File | null;
  onThumbnailChange: (file: File | null) => void;
  error: string | null;
}) {
  const thumbnailPreviewUrl = useObjectUrl(thumbnail);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Video</label>
        <div className="flex items-center gap-3">
          <div className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <FileVideo className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm"
              onChange={(event) =>
                onVideoChange(event.target.files?.[0] ?? null)
              }
              className="w-full text-xs"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {video ? video.name : "MP4, MOV or WebM — max 50MB."}
            </p>
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">
          Thumbnail{" "}
          <span className="font-normal text-muted-foreground">
            (cover image shown before the video plays)
          </span>
        </label>
        <div className="flex items-center gap-3">
          {thumbnailPreviewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbnailPreviewUrl}
              alt=""
              className="size-16 shrink-0 rounded-lg object-cover ring-1 ring-foreground/10"
            />
          ) : (
            <div className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <ImagePlus className="size-5" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) =>
                onThumbnailChange(event.target.files?.[0] ?? null)
              }
              className="w-full text-xs"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {thumbnail ? thumbnail.name : "JPEG, PNG or WebP — max 8MB."}
            </p>
          </div>
        </div>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
