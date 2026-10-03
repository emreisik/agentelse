import "server-only";

import { primaryPlatformOf, type WorkView } from "@/lib/works/work";

// A chat is free (docs/works.md): it is not bound to a channel, so nothing here
// refuses or asks. What stays is the channel-bound capability list and the
// default platform a piece lands on when the client did not name one: the
// first of the chat's default channels (the connected ones, stored with its
// first message), never a restriction.

// What create_task may produce FOR a channel; research and analysis do not need
// one. Publishing capabilities already name their platform.
export const CHANNEL_CONTENT_CAPABILITIES: ReadonlySet<string> = new Set([
  "CREATE_SOCIAL_CREATIVE",
  "CREATE_AD_CREATIVE",
  "CREATE_COPY",
  "CREATE_CAPTION",
  "CREATE_CAMPAIGN_BRIEF",
  "CREATE_CONTENT_PLAN",
]);

// The platform to use when the model did not name one.
export function defaultPlatformOf(work: WorkView | undefined) {
  return work ? primaryPlatformOf(work.channels) : undefined;
}
