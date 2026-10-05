import { isFlowModuleKey } from "@/lib/module-flows/card";
import { MODULES, type ModuleKey } from "@/lib/modules/catalog";
import { routeIntent } from "@/lib/modules/route-intent";

// What a message typed into a New Chat does while modules are on (plan P4):
// words clearly for the Social Media Planner make the chat that module's (it
// is stored first), and the words themselves are then sent as the chat's
// first message, live, exactly as typed (route-intent.ts decides, instant, no
// model). Everything else is a chat message exactly as before: modules off, a
// chat that has started or already has its module, a message with files, words
// for a module that is not built yet, words for Ads Manager, Analytics or SEO
// Manager (their flow card opens from a tile and takes no words, so routing
// would lose them: the agent answers instead) and anything unsure.

export type ComposerRoute =
  { kind: "chat" } | { kind: "module"; module: ModuleKey };

const CHAT: ComposerRoute = { kind: "chat" };

export function composerRoute(input: {
  modulesUi: boolean;
  // Nothing in the chat yet, and it is open.
  blank: boolean;
  // The module on screen; null for a general chat.
  module: ModuleKey | null;
  text: string;
  hasFiles: boolean;
}): ComposerRoute {
  if (!input.modulesUi || !input.blank || input.module !== null) return CHAT;
  if (input.hasFiles) return CHAT;
  let routed: ReturnType<typeof routeIntent>;
  try {
    routed = routeIntent(input.text);
  } catch {
    // The composer has already let go of the text: a rule that throws must
    // not lose the message.
    return CHAT;
  }
  // The same rule as the tiles: only a ready module, and only one that takes
  // the words as its first message (the Social Media Planner).
  if (!routed.module || !MODULES[routed.module].ready) return CHAT;
  if (isFlowModuleKey(routed.module)) return CHAT;
  return { kind: "module", module: routed.module };
}
