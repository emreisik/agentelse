import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { CHANNELS, type ChannelKey } from "@/lib/content-channels";
import { copyText } from "@/lib/works/copy";
import { cn } from "@/lib/utils";

export type WorkReturnTarget = { channel: ChannelKey; workId: string; title: string };

// Built inline: workHref lives in a 'use client' module a server component cannot call.
function hrefOf(projectId: string, workId: string): string {
  return `/projects/${projectId}?work=${encodeURIComponent(workId)}`;
}

function labelOf(title: string): string {
  const clean = title.trim();
  return clean ? copyText("cta.back", { title: clean }) : copyText("cta.backGeneric");
}

function BackLink({ projectId, workId, title }: { projectId: string; workId: string; title: string }) {
  return (
    <Link
      href={hrefOf(projectId, workId)}
      className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}
    >
      {labelOf(title)}
    </Link>
  );
}

// Single link: the pre-OAuth way back (?from=<workId>).
export function WorkReturnLink(props: { projectId: string; workId: string; title: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
      <BackLink {...props} />
    </div>
  );
}

// One row per connected channel that an open Work already covers.
export function WorkReturnLinks({
  projectId,
  links,
}: {
  projectId: string;
  links: readonly WorkReturnTarget[];
}) {
  if (links.length === 0) return null;
  return (
    <div className="space-y-2">
      {links.map((link) => (
        <div
          key={link.channel}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
        >
          <p className="text-sm">
            {copyText("cta.connected", { channel: CHANNELS[link.channel].label })}
          </p>
          <BackLink projectId={projectId} workId={link.workId} title={link.title} />
        </div>
      ))}
    </div>
  );
}
