// One look for every line of the project sidebar: the nav links and New Chat.
export const SIDEBAR_ITEM_CLASS =
  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors";
export const SIDEBAR_ACTIVE_CLASS =
  "bg-sidebar-accent font-medium text-sidebar-accent-foreground";

// The docked sidebar's collapsed (icon rail) state, ChatGPT-style. A cookie,
// not localStorage, so the server renders the right width on the first paint.
// Kept in this plain module: a constant imported from a "use client" file is a
// client reference on the server, not the string.
export const SIDEBAR_COLLAPSED_COOKIE = "agentelse-sidebar";

// Collapsed rail lines: a square icon button instead of icon + label.
export const SIDEBAR_RAIL_ITEM_CLASS =
  "relative mx-auto flex size-10 items-center justify-center rounded-lg text-sidebar-foreground transition-colors";
