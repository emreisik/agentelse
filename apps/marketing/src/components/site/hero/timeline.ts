import type { PillTone } from "@/components/site/mock/parts";

// The hero demo's script: one ~30 second loop through the product, scene by
// scene. Everything on screen is derived from a single clock position (`pos`,
// ms since the loop started), so jumping to a scene is just moving the clock.

export const SCENES = [
  { key: "ask", label: "Ask", caption: "Ask in one sentence.", duration: 6000 },
  {
    key: "plan",
    label: "Plan",
    caption: "One plan for every channel.",
    duration: 5400,
  },
  {
    key: "create",
    label: "Create",
    caption: "Posts made in your style.",
    duration: 5000,
  },
  {
    key: "approve",
    label: "Approve",
    caption: "You approve with one tap.",
    duration: 4200,
  },
  {
    key: "publish",
    label: "Publish",
    caption: "It goes out on time.",
    duration: 4400,
  },
  {
    key: "learn",
    label: "Learn",
    caption: "It learns what worked.",
    duration: 5200,
  },
] as const;

export type SceneKey = (typeof SCENES)[number]["key"];

const STARTS: number[] = SCENES.reduce<number[]>((acc, _scene, index) => {
  acc.push(index === 0 ? 0 : acc[index - 1]! + SCENES[index - 1]!.duration);
  return acc;
}, []);

export const TOTAL = SCENES.reduce((sum, scene) => sum + scene.duration, 0);

export function sceneIndex(key: SceneKey): number {
  return SCENES.findIndex((scene) => scene.key === key);
}

export function startOf(key: SceneKey): number {
  return STARTS[sceneIndex(key)] ?? 0;
}

// An absolute moment: `ms` into scene `key`.
export function at(key: SceneKey, ms: number): number {
  return startOf(key) + ms;
}

export function sceneAt(pos: number): number {
  for (let index = SCENES.length - 1; index >= 0; index -= 1) {
    if (pos >= (STARTS[index] ?? 0)) return index;
  }
  return 0;
}

// 0 → 1 between two moments, clamped.
export function progress(pos: number, from: number, to: number): number {
  if (to <= from) return pos >= to ? 1 : 0;
  return Math.min(1, Math.max(0, (pos - from) / (to - from)));
}

export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// ---- The words ------------------------------------------------------------

export const ASK_TEXT =
  "Plan next week for Instagram and Facebook. We launch the autumn menu on Thursday.";

export const REPLY_TEXT =
  "Here's your week: a teaser on Monday, the launch on Thursday morning and a lighter post on Saturday.";

// ---- Key moments ------------------------------------------------------------

export const T = {
  typeFrom: at("ask", 700),
  typeTo: at("ask", 3300),
  send: at("ask", 4100),
  thinking: at("ask", 4400),
  replyFrom: at("plan", 0),
  replyTo: at("plan", 1300),
  planCard: at("plan", 1500),
  planPane: at("plan", 1900),
  planRowsFrom: at("plan", 2100),
  prepare: at("plan", 4000),
  outputsPane: at("create", 600),
  makingLine: at("create", 300),
  createFrom: at("create", 900),
  readyLine: at("create", 4300),
  postPane: at("approve", 0),
  approve: at("approve", 1200),
  toastTo: at("approve", 3800),
  calendarPane: at("publish", 600),
  drop: at("publish", 900),
  published: at("publish", 2700),
  brandPane: at("learn", 600),
  results: at("learn", 800),
  countFrom: at("learn", 1100),
  countTo: at("learn", 2300),
  worked: at("learn", 3000),
  hideCursor: at("learn", 3700),
} as const;

// ---- The cursor ---------------------------------------------------------------

export type CursorTarget =
  | "composer"
  | "send"
  | "prepare"
  | "dock-outputs"
  | "approve"
  | "dock-calendar"
  | "dock-brand"
  | "worked";

const CURSOR: { at: number; target: CursorTarget | null; clickAt?: number }[] =
  [
    { at: at("ask", 300), target: "composer", clickAt: at("ask", 650) },
    { at: at("ask", 3500), target: "send", clickAt: T.send },
    { at: at("ask", 4600), target: null },
    { at: at("plan", 3400), target: "prepare", clickAt: T.prepare },
    { at: at("create", 0), target: "dock-outputs", clickAt: at("create", 500) },
    { at: at("create", 1400), target: null },
    { at: at("approve", 600), target: "approve", clickAt: T.approve },
    { at: at("approve", 2400), target: null },
    {
      at: at("publish", 0),
      target: "dock-calendar",
      clickAt: at("publish", 500),
    },
    { at: at("publish", 1400), target: null },
    { at: at("learn", 0), target: "dock-brand", clickAt: at("learn", 500) },
    { at: at("learn", 2400), target: "worked", clickAt: T.worked },
    { at: T.hideCursor, target: null },
  ];

export function cursorAt(pos: number): {
  target: CursorTarget | null;
  clickAt: number | null;
} {
  let current: (typeof CURSOR)[number] | null = null;
  for (const frame of CURSOR) {
    if (frame.at <= pos) current = frame;
  }
  if (!current) return { target: null, clickAt: null };
  return { target: current.target, clickAt: current.clickAt ?? null };
}

// ---- What the right side shows ----------------------------------------------

export type Pane = "brand" | "plan" | "outputs" | "post" | "calendar";

export function paneAt(pos: number): Pane {
  if (pos >= T.brandPane) return "brand";
  if (pos >= T.calendarPane) return "calendar";
  if (pos >= T.postPane) return "post";
  if (pos >= T.outputsPane) return "outputs";
  if (pos >= T.planPane) return "plan";
  return "brand";
}

// The dock icon pressed in for a pane: a plan card takes the panel's place, so
// no icon is pressed while it's on show (as in the product).
export function dockAt(pane: Pane): "brand" | "outputs" | "calendar" | null {
  if (pane === "brand") return "brand";
  if (pane === "outputs" || pane === "post") return "outputs";
  if (pane === "calendar") return "calendar";
  return null;
}

// On narrow screens only one side fits: the side the story is about.
export function focusAt(pos: number): "chat" | "pane" {
  if (pos >= T.brandPane) return "chat";
  if (pos >= T.planPane) return "pane";
  return "chat";
}

// ---- The three posts of the plan ------------------------------------------

export const POSTS = [
  { day: "Mon", date: 13, time: "08:30", title: "Behind the roast", kicker: "Single origin", tone: "dark" },
  { day: "Thu", date: 16, time: "09:00", title: "The autumn menu is here", kicker: "New this week", tone: "warm" },
  { day: "Sat", date: 18, time: "11:00", title: "Pumpkin spice, done properly", kicker: "Weekend", tone: "cream" },
] as const;

// The launch post: the one approved, scheduled and published in the story.
export const FEATURED = 1;

// How far the picture of post `index` is (0 → 1).
export function postProgress(index: number, pos: number): number {
  const from = T.createFrom + index * 450;
  return progress(pos, from, from + 2300);
}

export function postStatus(
  index: number,
  pos: number,
): { label: string; tone: PillTone; live?: boolean } {
  if (pos < T.prepare) return { label: "Idea", tone: "neutral" };
  if (postProgress(index, pos) < 1) return { label: "Making…", tone: "live", live: true };
  if (index === FEATURED && pos >= T.published) return { label: "Published", tone: "positive" };
  if (index === FEATURED && pos >= T.approve) return { label: "Scheduled", tone: "positive" };
  return { label: "In review", tone: "waiting" };
}
