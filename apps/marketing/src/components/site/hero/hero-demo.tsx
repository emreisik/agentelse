"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  BookOpen,
  CalendarDays,
  FolderOpen,
  Gem,
  Layers,
  Library,
  MoreHorizontal,
  PanelRightClose,
  Pause,
  Play,
  Sparkles,
  SquarePen,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { BrandAvatar, DEMO_BRAND } from "@/components/site/mock/parts";
import { DemoChat } from "@/components/site/hero/demo-chat";
import {
  BrandPane,
  CalendarPane,
  OutputsPane,
  PlanPane,
  PostPane,
} from "@/components/site/hero/demo-panes";
import {
  SCENES,
  T,
  TOTAL,
  cursorAt,
  dockAt,
  focusAt,
  paneAt,
  sceneAt,
  startOf,
  type Pane,
} from "@/components/site/hero/timeline";

// The hero: the product itself, playing. One clock drives the whole window;
// the scene tabs above it show where the story is and jump to any part.

const FRAME_MS = 32;

function endOf(index: number): number {
  const scene = SCENES[index] ?? SCENES[0];
  return startOf(scene.key) + scene.duration - 1;
}

export function HeroDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const windowId = useId();
  const [pos, setPos] = useState(0);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      setReduced(query.matches);
      // A still picture that tells the story: the approved post.
      if (query.matches) setPos(endOf(3));
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  // Only play while someone can see it.
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    let inView = true;
    let tabVisible = !document.hidden;
    const update = () => setVisible(inView && tabVisible);
    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = Boolean(entry?.isIntersecting);
        update();
      },
      { threshold: 0.1 },
    );
    observer.observe(node);
    const onVisibility = () => {
      tabVisible = !document.hidden;
      update();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const running = visible && !paused && !reduced;

  useEffect(() => {
    if (!running) return;
    let frame = 0;
    let last = performance.now();
    let carry = 0;
    const loop = (now: number) => {
      carry += Math.min(now - last, 120);
      last = now;
      if (carry >= FRAME_MS) {
        const step = carry;
        carry = 0;
        setPos((current) => {
          const next = current + step;
          return next >= TOTAL ? 0 : next;
        });
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [running]);

  const scene = sceneAt(pos);
  const current = SCENES[scene] ?? SCENES[0];
  const elapsed = pos - startOf(current.key);
  const pane = paneAt(pos);
  const focus = focusAt(pos);

  function jump(index: number) {
    const target = SCENES[index];
    if (!target) return;
    setPos(reduced ? endOf(index) : startOf(target.key));
  }

  function onTabKey(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const delta =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + SCENES.length) % SCENES.length;
    jump(next);
    document.getElementById(`${windowId}-tab-${next}`)?.focus();
  }

  return (
    <div ref={rootRef} className="flex w-full flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div
          role="tablist"
          aria-label="See Agentelse at work"
          className="grid grid-cols-3 gap-x-3 gap-y-3 sm:grid-cols-6 sm:gap-4"
        >
          {SCENES.map((item, index) => {
            const selected = index === scene;
            const fill =
              index < scene ? 1 : selected ? elapsed / item.duration : 0;
            return (
              <button
                key={item.key}
                id={`${windowId}-tab-${index}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={windowId}
                tabIndex={selected ? 0 : -1}
                onClick={() => jump(index)}
                onKeyDown={(event) => onTabKey(event, index)}
                className="group flex min-w-0 flex-col gap-2.5 rounded-md pt-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="h-[3px] overflow-hidden rounded-full bg-foreground/10">
                  <span
                    className="block h-full origin-left rounded-full bg-foreground"
                    style={{
                      transform: `scaleX(${Math.min(1, Math.max(0, fill))})`,
                    }}
                  />
                </span>
                <span
                  className={cn(
                    "truncate text-[12.5px] font-medium transition-colors duration-300 sm:text-sm",
                    selected
                      ? "text-foreground"
                      : "text-muted-foreground group-hover:text-foreground",
                  )}
                >
                  <span className="hidden text-muted-foreground tabular-nums sm:inline">
                    0{index + 1}{" "}
                  </span>
                  {item.label}
                </span>
                <span
                  className={cn(
                    "hidden text-[13px] leading-snug transition-colors duration-300 lg:block",
                    selected
                      ? "text-muted-foreground"
                      : "text-muted-foreground/50",
                  )}
                >
                  {item.caption}
                </span>
              </button>
            );
          })}
        </div>
        <p
          key={current.key}
          className="animate-in fade-in text-center text-sm text-muted-foreground duration-500 lg:hidden"
        >
          {current.caption}
        </p>
      </div>

      <div className="relative">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-x-10 top-16 -bottom-10 rounded-[3rem] opacity-80 blur-3xl"
          style={{
            background:
              "radial-gradient(60% 60% at 50% 40%, oklch(0.6 0.22 293 / 0.18), transparent 70%)",
          }}
        />
        <div
          id={windowId}
          ref={windowRef}
          role="tabpanel"
          aria-label={`${current.label}: ${current.caption}`}
          className="relative overflow-hidden rounded-[22px] border border-border bg-card text-left shadow-[var(--shadow-float)]"
        >
          <div aria-hidden="true">
            <div className="flex h-10 items-center gap-2 border-b border-border bg-muted px-4">
              <span className="size-2.5 rounded-full bg-[#FF5F57]" />
              <span className="size-2.5 rounded-full bg-[#FEBC2E]" />
              <span className="size-2.5 rounded-full bg-[#28C840]" />
              <span className="mx-auto rounded-md bg-background px-10 py-1 text-[11px] text-muted-foreground sm:px-16">
                agentelse.ai
              </span>
              <span className="w-[42px]" />
            </div>

            <div className="flex h-[540px] lg:h-[600px]">
              <DemoSidebar pos={pos} />
              <div
                className={cn(
                  "min-w-0 flex-1 flex-col",
                  focus === "pane" ? "hidden lg:flex" : "flex",
                )}
              >
                <DemoChat pos={pos} />
              </div>
              <div
                className={cn(
                  "min-w-0 flex-1 flex-col border-l border-border bg-muted/60 lg:w-[330px] lg:flex-none",
                  focus === "pane" ? "flex" : "hidden lg:flex",
                )}
              >
                <div
                  key={pane}
                  className="animate-in fade-in slide-in-from-right-4 h-full duration-500"
                >
                  <PaneView pane={pane} pos={pos} />
                </div>
              </div>
              <DemoDock active={dockAt(pane)} />
            </div>
          </div>

          <DemoCursor containerRef={windowRef} pos={pos} enabled={!reduced} />
        </div>

        <button
          type="button"
          onClick={() => setPaused((value) => !value)}
          aria-label={paused ? "Play the demo" : "Pause the demo"}
          className="absolute top-1.5 right-2.5 flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-background hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {paused || reduced ? (
            <Play className="size-3.5" />
          ) : (
            <Pause className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

function PaneView({ pane, pos }: { pane: Pane; pos: number }) {
  switch (pane) {
    case "plan":
      return <PlanPane pos={pos} />;
    case "outputs":
      return <OutputsPane pos={pos} />;
    case "post":
      return <PostPane pos={pos} />;
    case "calendar":
      return <CalendarPane pos={pos} />;
    default:
      return <BrandPane pos={pos} />;
  }
}

// ---- Sidebar ------------------------------------------------------------------

const MENU: { label: string; Icon: LucideIcon }[] = [
  { label: "Brand Brain", Icon: Gem },
  { label: "Ideas", Icon: Sparkles },
  { label: "Library", Icon: Library },
  { label: "Content Calendar", Icon: CalendarDays },
];

const OLDER_RECENTS = [
  "Weekend promo ideas",
  "Barista tips series",
  "Why did Tuesday's post work?",
];

function DemoSidebar({ pos }: { pos: number }) {
  const started = pos >= T.send;
  return (
    <div className="hidden w-[208px] shrink-0 flex-col gap-0.5 border-r border-border bg-[oklch(0.985_0.003_260)] p-2.5 md:flex">
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-background p-2">
        <BrandAvatar className="size-7 rounded-lg" />
        <div className="min-w-0">
          <p className="truncate text-[12px] font-semibold">
            {DEMO_BRAND.name}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {DEMO_BRAND.site}
          </p>
        </div>
      </div>
      <SidebarRow Icon={SquarePen} label="New chat" active={!started} strong />
      {MENU.map(({ label, Icon }) => (
        <SidebarRow key={label} Icon={Icon} label={label} />
      ))}
      <SidebarRow Icon={MoreHorizontal} label="Explore" />
      <p className="mt-3 mb-1 px-2 text-[10px] font-medium text-muted-foreground">
        Recents
      </p>
      {started ? (
        <span className="animate-in fade-in slide-in-from-top-1 truncate rounded-lg bg-secondary px-2 py-1.5 text-[12px] font-medium duration-500">
          Autumn menu launch
        </span>
      ) : null}
      {OLDER_RECENTS.map((title) => (
        <span
          key={title}
          className="truncate rounded-lg px-2 py-1.5 text-[12px] text-foreground/70"
        >
          {title}
        </span>
      ))}
    </div>
  );
}

function SidebarRow({
  Icon,
  label,
  active = false,
  strong = false,
}: {
  Icon: LucideIcon;
  label: string;
  active?: boolean;
  strong?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] transition-colors duration-300",
        active && "bg-secondary",
        strong ? "font-medium text-foreground" : "text-foreground/80",
      )}
    >
      <Icon className="size-3.5 text-muted-foreground" />
      {label}
    </span>
  );
}

// ---- Dock -----------------------------------------------------------------------

const DOCK: {
  key: "brand" | "files" | "outputs" | "calendar";
  Icon: LucideIcon;
  target?: string;
}[] = [
  { key: "brand", Icon: BookOpen, target: "dock-brand" },
  { key: "files", Icon: FolderOpen },
  { key: "outputs", Icon: Layers, target: "dock-outputs" },
  { key: "calendar", Icon: CalendarDays, target: "dock-calendar" },
];

// The product's right dock: the panel toggle, then Brand, Files, Outputs and
// Calendar. The pressed-in look slides to the open panel's icon.
function DemoDock({
  active,
}: {
  active: "brand" | "outputs" | "calendar" | null;
}) {
  const index = DOCK.findIndex((item) => item.key === active);
  return (
    <div className="hidden w-12 shrink-0 flex-col items-center gap-1 border-l border-border py-3 text-muted-foreground md:flex">
      <span className="flex size-9 items-center justify-center rounded-lg">
        <PanelRightClose className="size-4" />
      </span>
      <span className="my-1 h-px w-5 bg-border" />
      <div className="relative flex flex-col gap-1">
        <span
          className="absolute top-0 left-0 size-9 rounded-lg bg-secondary transition-[transform,opacity] duration-500 ease-[var(--site-ease)]"
          style={{
            transform: `translateY(${Math.max(index, 0) * 40}px)`,
            opacity: index >= 0 ? 1 : 0,
          }}
        />
        {DOCK.map(({ key, Icon, target }, itemIndex) => (
          <span
            key={key}
            data-demo-target={target}
            className={cn(
              "relative flex size-9 items-center justify-center rounded-lg transition-colors duration-300",
              itemIndex === index && "text-foreground",
            )}
          >
            <Icon className="size-4" />
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- Cursor -------------------------------------------------------------------

type Point = { x: number; y: number; shown: boolean };

// A pointer that moves to whatever the story clicks next. It measures the
// target in the window after each paint, so it lands right at every size.
function DemoCursor({
  containerRef,
  pos,
  enabled,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  pos: number;
  enabled: boolean;
}) {
  const { target, clickAt } = cursorAt(pos);
  const [point, setPoint] = useState<Point | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    let next: { x: number; y: number } | null = null;
    if (enabled && target) {
      const element = root.querySelector<HTMLElement>(
        `[data-demo-target="${target}"]`,
      );
      const rect = element?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        next = {
          x: rect.left - base.left + Math.min(rect.width * 0.5, 40),
          y: rect.top - base.top + rect.height * 0.6,
        };
      }
    }
    setPoint((previous) => {
      if (!next) {
        return previous && previous.shown
          ? { ...previous, shown: false }
          : previous;
      }
      // First appearance: start low in the window, then glide to the target.
      if (!previous)
        return { x: base.width * 0.62, y: base.height * 0.92, shown: true };
      if (
        previous.shown &&
        Math.abs(previous.x - next.x) < 0.5 &&
        Math.abs(previous.y - next.y) < 0.5
      ) {
        return previous;
      }
      return { ...next, shown: true };
    });
  }, [containerRef, enabled, pos, target]);

  if (!point) return null;
  const clicking = clickAt !== null && pos >= clickAt && pos < clickAt + 420;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0 z-20 transition-[transform,opacity] duration-700 ease-[var(--site-ease)]"
      style={{
        transform: `translate(${point.x}px, ${point.y}px)`,
        opacity: point.shown ? 1 : 0,
      }}
    >
      {clicking ? <span key={clickAt} className="demo-ripple" /> : null}
      <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        className="relative -translate-x-[3px] -translate-y-[2px] drop-shadow-[0_2px_3px_rgb(0_0_0/0.25)] transition-transform duration-150"
        style={{ transform: clicking ? "scale(0.86)" : undefined }}
      >
        <path
          d="M3.5 2.2 16 9.6l-5.6 1.3-2.9 5.3L3.5 2.2Z"
          fill="#14161d"
          stroke="#fff"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
