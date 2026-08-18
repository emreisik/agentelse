import { Section } from "@/components/marketing/section";
import { Reveal } from "@/components/marketing/reveal";
import { cn } from "@/lib/utils";

const PROMPT_TOOL_DETAILS = [
  { label: "Trigger", value: "Your next prompt" },
  { label: "Coordinator", value: "You" },
  { label: "Finish line", value: "A one-off answer" },
] as const;

const AGENTELSE_DETAILS = [
  { label: "Trigger", value: "Live business signals" },
  { label: "Coordinator", value: "Agency Director" },
  { label: "Finish line", value: "Executed work + learning" },
] as const;

// Same card anatomy and OKLCH values as the real product's Fikirler board
// (src/components/hub-core/panels/idea-lens-board.tsx, src/lib/labels) and
// the homepage's AppKanbanShowcase — a smaller, embedded slice of the exact
// same board rather than a fresh mockup.
const MINI_DEPT_COLORS = {
  creative: "oklch(0.55 0.2 346)",
  growth: "oklch(0.5 0.14 145)",
  intel: "oklch(0.6 0.13 222)",
} as const;

const MINI_TONE_STYLES = {
  active:
    "bg-[oklch(0.19_0.014_260)]/12 text-[oklch(0.19_0.014_260)] ring-1 ring-[oklch(0.19_0.014_260)]/25",
  positive:
    "bg-[oklch(0.6_0.135_155)]/15 text-[oklch(0.6_0.135_155)] ring-1 ring-[oklch(0.6_0.135_155)]/25",
} as const;

type MiniTone = keyof typeof MINI_TONE_STYLES;
type MiniDept = keyof typeof MINI_DEPT_COLORS;

const MINI_BOARD: Array<{
  key: string;
  label: string;
  cards: Array<{
    title: string;
    dept: MiniDept;
    deptLabel: string;
    lens: string;
    status: string;
    tone: MiniTone;
    council?: ("go" | "warn")[];
  }>;
}> = [
  {
    key: "approved",
    label: "Approved",
    cards: [
      {
        title: "Instagram carousel — product benefits",
        dept: "creative",
        deptLabel: "Social Media",
        lens: "Social",
        status: "Planning",
        tone: "active",
        council: ["go", "go"],
      },
    ],
  },
  {
    key: "executing",
    label: "In execution",
    cards: [
      {
        title: "Search console opportunity brief",
        dept: "growth",
        deptLabel: "SEO",
        lens: "Growth",
        status: "Running",
        tone: "active",
        council: ["go", "go"],
      },
      {
        title: "Competitor positioning analysis",
        dept: "intel",
        deptLabel: "Market Intelligence",
        lens: "Brand",
        status: "Measuring",
        tone: "active",
      },
    ],
  },
];

export function StopManagingAi() {
  return (
    <Section id="autonomous-ai" tone="raised" className="overflow-hidden">
      <Reveal className="grid gap-8 lg:grid-cols-12 lg:items-end">
        <div className="lg:col-span-7">
          <p className="agentelse-text-caption font-medium text-muted-foreground uppercase">
            A different kind of AI
          </p>
          <h2 className="agentelse-text-h2 mt-5 max-w-[15ch] text-balance">
            Stop managing AI. Give it a job.
          </h2>
        </div>

        <p className="agentelse-text-lead max-w-[46ch] text-foreground/75 lg:col-span-4 lg:col-start-9">
          Prompt tools make you the operator. Agentelse works like an autonomous
          agency: it watches, coordinates and delivers within the rules you set.
        </p>
      </Reveal>

      <Reveal className="mt-14 md:mt-20" delayMs={100}>
        <div className="grid border-y border-foreground/15 lg:grid-cols-2">
          <article className="py-10 lg:py-12 lg:pr-12">
            <div className="flex items-center justify-between gap-6">
              <p className="agentelse-text-label text-muted-foreground">
                Prompt tool
              </p>
              <span className="agentelse-text-caption text-muted-foreground">
                Reactive
              </span>
            </div>

            <h3 className="agentelse-text-h2 mt-10 text-balance">Waits.</h3>
            <p className="agentelse-text-lead mt-4 max-w-[32ch] text-foreground">
              Every task starts with you. It replies, then the work stops.
            </p>
            <p className="mt-3 max-w-[44ch] text-base text-muted-foreground">
              You carry the context, write every instruction and decide what
              happens next.
            </p>

            <dl className="mt-10 border-t border-foreground/15">
              {PROMPT_TOOL_DETAILS.map((detail) => (
                <div
                  key={detail.label}
                  className="grid grid-cols-[6.5rem_1fr] gap-5 border-b border-foreground/15 py-4 sm:grid-cols-[8rem_1fr]"
                >
                  <dt className="text-sm text-muted-foreground">
                    {detail.label}
                  </dt>
                  <dd className="text-sm font-medium text-foreground">
                    {detail.value}
                  </dd>
                </div>
              ))}
            </dl>
          </article>

          <article className="-mx-[var(--agentelse-space-gutter)] bg-foreground px-[var(--agentelse-space-gutter)] py-10 text-background lg:mx-0 lg:px-12 lg:py-12">
            <div className="flex items-center justify-between gap-6">
              <p className="agentelse-text-label text-background">Agentelse</p>
              <span className="flex items-center gap-2 agentelse-text-caption text-background/65">
                <span
                  className="agentelse-live-dot size-1.5 rounded-full bg-background"
                  aria-hidden="true"
                />
                Always working
              </span>
            </div>

            <h3 className="agentelse-text-h2 mt-10 text-balance text-background">
              Moves.
            </h3>
            <p className="agentelse-text-lead mt-4 max-w-[34ch] text-background">
              Work continues without you pushing it.
            </p>
            <p className="mt-3 max-w-[44ch] text-base text-background/70">
              Set the objective once. The Agency Director keeps specialist
              departments moving and brings you the decisions that need you.
            </p>

            <div className="mt-8 grid grid-cols-2 gap-3">
              {MINI_BOARD.map((column) => (
                <div key={column.key}>
                  <p className="agentelse-text-caption text-background/55">
                    {column.label}
                  </p>
                  <div className="mt-2 flex flex-col gap-2">
                    {column.cards.map((card) => (
                      <div
                        key={card.title}
                        className="rounded-lg bg-white p-2.5 shadow-xs ring-1 ring-black/10"
                      >
                        <p className="line-clamp-2 text-[11px] leading-snug font-medium text-[#1b1b1b]">
                          {card.title}
                        </p>
                        <span
                          className="mt-1.5 inline-flex w-fit items-center rounded-sm px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase"
                          style={{
                            backgroundColor: MINI_DEPT_COLORS[card.dept],
                          }}
                        >
                          {card.deptLabel}
                        </span>
                        <div className="mt-1.5 flex items-center justify-between gap-1.5">
                          <div className="flex items-center gap-1">
                            <span className="inline-flex h-4 items-center rounded-full bg-black/5 px-1.5 text-[9px] font-medium text-[#666]">
                              {card.lens}
                            </span>
                            <span
                              className={cn(
                                "inline-flex h-4 items-center rounded-full px-1.5 text-[9px] font-medium",
                                MINI_TONE_STYLES[card.tone],
                              )}
                            >
                              {card.status}
                            </span>
                          </div>
                          {card.council ? (
                            <div className="flex items-center gap-0.5">
                              {card.council.map((vote, i) => (
                                <span
                                  key={i}
                                  className={cn(
                                    "size-1.5 rounded-full",
                                    vote === "go"
                                      ? "bg-[oklch(0.6_0.135_155)]"
                                      : "bg-[oklch(0.685_0.16_63)]",
                                  )}
                                />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <dl className="mt-10 border-t border-background/20">
              {AGENTELSE_DETAILS.map((detail) => (
                <div
                  key={detail.label}
                  className="grid grid-cols-[6.5rem_1fr] gap-5 border-b border-background/20 py-4 sm:grid-cols-[8rem_1fr]"
                >
                  <dt className="text-sm text-background/55">{detail.label}</dt>
                  <dd className="text-sm font-medium text-background">
                    {detail.value}
                  </dd>
                </div>
              ))}
            </dl>
          </article>
        </div>
      </Reveal>
    </Section>
  );
}
