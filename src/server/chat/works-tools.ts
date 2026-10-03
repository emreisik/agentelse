import "server-only";

import { z } from "zod";

import { isChannelKey } from "@/lib/content-channels";
import { prisma } from "@/lib/prisma";
import {
  blocksOf,
  brandCheckOf,
  brandRepairMessage,
  checkItems,
  type BrandRuleSet,
  type ItemFlag,
  type PlanTextItem,
} from "@/lib/works/brand-rules";
import { cleanWorksText, reasonSentence } from "@/lib/works/clean-text";
import { copyText } from "@/lib/works/copy";
import {
  IdeaOptionsArgsSchema,
  MAX_IDEAS_PER_CARD,
  type IdeaOptionItem,
  type IdeaOptionsArgs,
  type IdeaOptionsCardData,
} from "@/lib/works/idea-options";
import {
  MAX_OPTION_SLOTS,
  describePlanSlots,
  layoutPlanSlots,
  type PlanSlot,
} from "@/lib/works/plan-layout";
import {
  PlanOptionsArgsSchema,
  buildOptionsCard,
  optionsShapeError,
  type PlanOptionsArgs,
} from "@/lib/works/plan-options";
import {
  MasterContentArgsSchema,
  buildMasterCard,
} from "@/lib/works/master-content";
import { channelListText } from "@/lib/works/work";
import { parsePlanBrief, type PlanBrief } from "@/lib/plan-brief";
import { foldForMatch } from "@/lib/text-fold";
import { limitNoticeReplyText } from "@/server/commands/limit-notice";
import { saveIdea } from "@/server/commands/strategic-request";
import {
} from "@/server/works/channel-gate";

import {
  getProjectTimezone,
  supersedeOpenPlanCards,
  todayInTimezone,
} from "./content-plan";
import type { ChatTool, ToolContext, ToolOutcome } from "./tools";

// The Works-only tools of the chat agent (spec 3.2.3 and 3.4.7). They are
// offered only while a Work exists (`requiresWorks`), so a flag-off turn never
// sees them. tools.ts gains the context fields below in a later task; until
// then they are declared locally and read defensively.

type BrandRulesGetter = () => Promise<BrandRuleSet | null>;

type WorksCtx = ToolContext & {
  // Which kind of card owns this turn: a plan draft or slot-first pieces.
  planOwner?: "draft" | "slots";
  getBrandRules?: BrandRulesGetter;
  // One brand-rule repair round per turn, shared by every card-writing tool.
  brandRuleRepairs?: number;
  // One text-cleaning repair round per turn.
  cleanRepairs?: number;
  shapeRepairs?: number;
  // Set by the first propose_ideas call of a turn.
  ideasShown?: boolean;
  // The newest [Plan brief] of this Work, for a typed change without one.
  planBriefFallback?: PlanBrief | null;
};

type WorksOutcome = ToolOutcome & { endTurn?: boolean };

type WorksTool<TArgs> = Omit<ChatTool<TArgs>, "execute"> & {
  requiresWorks: true;
  execute(args: TArgs, ctx: WorksCtx): Promise<WorksOutcome>;
};

function defineWorksTool<TArgs>(tool: WorksTool<TArgs>): ChatTool {
  return tool as unknown as ChatTool;
}

const OPTION_LETTERS = ["A", "B", "C"] as const;
const IDEA_TEXT_MAX = 600;
const MAX_CLEAN_ERRORS_SHOWN = 3;
const MAX_LIVE_IDEAS = 100;
const NO_PLAN_BRIEF_ERROR =
  "There is no [Plan brief] in this message or in the recent conversation.";

// --- helpers ---------------------------------------------------------------

type CleanFailure = { place: string; reason: string };

function rejectedLine(failure: CleanFailure): string {
  return `${failure.place} was rejected: ${failure.reason}. Rewrite it as a plain marketing line.`;
}

// 'HH:mm' in the project timezone, for the "today" anchor of the layout.
function localTimeOf(timezone: string, now = new Date()): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now);
  } catch {
    return undefined;
  }
}

// Fail open: a rule set that cannot be loaded never blocks the card.
async function loadRules(ctx: WorksCtx): Promise<BrandRuleSet | null> {
  if (!ctx.getBrandRules) return null;
  try {
    return await ctx.getBrandRules();
  } catch {
    return null;
  }
}

// The first failing cleaning of a turn is returned for repair; a second one
// ends the loop so identical text is not retried round after round.
function cleaningError(
  ctx: Pick<WorksCtx, "cleanRepairs">,
  failures: readonly CleanFailure[],
  subject: "directions" | "ideas" | "plan" | "message",
): ToolOutcome {
  if ((ctx.cleanRepairs ?? 0) >= 1) {
    return {
      result: {
        error: `Stop: tell the client the ${subject} could not be written and ask them to rephrase the goal`,
      },
    };
  }
  ctx.cleanRepairs = 1;
  return {
    result: {
      error: failures
        .slice(0, MAX_CLEAN_ERRORS_SHOWN)
        .map(rejectedLine)
        .join(" "),
      note:
        subject === "directions"
          ? "Fix the options and call propose_plan_options again."
          : subject === "plan"
            ? "Fix the plan and call propose_content_plan again with the full plan."
            : subject === "message"
              ? "Fix the message and call propose_master_content again."
              : "Fix the ideas and call propose_ideas again.",
    },
  };
}

// --- propose_content_plan (Works) --------------------------------------------

type PlanTextArgs = {
  title: string;
  items: readonly { topic: string; captionIdea: string }[];
};

// The text of a plan the model drafts in a Work (title, topics, caption ideas)
// becomes Creative.title / brief and is quoted back to a model at production,
// so it passes the same cleaner as the options and ideas tools. One repair
// round per turn, shared with them (ctx.cleanRepairs).
export function cleanPlanText<T extends PlanTextArgs>(
  ctx: Pick<WorksCtx, "cleanRepairs">,
  args: T,
): { ok: true; args: T } | { ok: false; outcome: ToolOutcome } {
  const failures: CleanFailure[] = [];
  const clean = (raw: string, max: number, place: string): string => {
    const result = cleanWorksText(raw, max);
    if (result.ok) return result.text;
    failures.push({ place, reason: reasonSentence(result.reason) });
    return "";
  };
  const title = clean(args.title, 120, "The title");
  const items = args.items.map((item, index) => ({
    ...item,
    topic: clean(item.topic, 120, `Item ${index + 1} (topic)`),
    captionIdea: clean(
      item.captionIdea,
      IDEA_TEXT_MAX,
      `Item ${index + 1} (captionIdea)`,
    ),
  }));
  if (failures.length > 0) {
    return {
      ok: false,
      outcome: cleaningError(ctx, failures, "plan"),
    };
  }
  return { ok: true, args: { ...args, title, items } as T };
}

// --- propose_plan_options --------------------------------------------------

type CleanedOptions =
  { ok: true; args: PlanOptionsArgs } | { ok: false; failures: CleanFailure[] };

function cleanOptionsArgs(args: PlanOptionsArgs): CleanedOptions {
  const failures: CleanFailure[] = [];
  const clean = (raw: string, max: number, place: string): string => {
    const result = cleanWorksText(raw, max);
    if (result.ok) return result.text;
    failures.push({ place, reason: reasonSentence(result.reason) });
    return "";
  };

  const title = clean(args.title, 80, "The title");
  const reason = clean(args.reason, 160, "The reason");
  const options = args.options.map((option, oi) => {
    const letter = OPTION_LETTERS[oi] ?? `${oi + 1}`;
    const label = clean(option.label, 40, `Option ${letter} (label)`);
    const angle = clean(option.angle, 200, `Option ${letter} (angle)`);
    // The basis is optional provenance: dropped quietly when it does not clean.
    const basis =
      option.basis === undefined ? null : cleanWorksText(option.basis, 80);
    const ideas = option.ideas.map((idea, ii) => {
      const place = `Option ${letter} idea ${ii + 1}`;
      return {
        topic: clean(idea.topic, 120, `${place} (topic)`),
        captionIdea: clean(idea.captionIdea, 200, `${place} (captionIdea)`),
      };
    });
    return {
      label,
      angle,
      ...(basis?.ok ? { basis: basis.text } : {}),
      ideas,
    };
  });

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, args: { ...args, title, reason, options } };
}

const proposePlanOptions = defineWorksTool<PlanOptionsArgs>({
  name: "propose_plan_options",
  label: "Preparing plan directions…",
  kind: "note",
  phases: ["ACTIVE"],
  requiresWorks: true,
  description:
    "Show the client 2-3 directions for the plan described by the [Plan brief] line, as one card they pick from (no revise round trip). The server fixes the days, channels and formats (the numbered slots in your context); you write the ideas: each option has a label (2-4 words), an angle (one sentence tied to a concrete fact in the brand profile or memory), optionally a basis (that fact in a few words) and exactly one idea per slot in slot order, each with a concrete topic and a captionIdea (at most 200 characters) in the brand voice and language. The options must differ in angle, not in wording. Obey every negative rule and approved claim. Ends your turn when it succeeds: do not describe the options.",
  schema: PlanOptionsArgsSchema,
  async execute(args, ctx) {
    const work = ctx.work;
    if (!work) {
      return {
        result: {
          error: "Plan directions only exist inside a Work.",
          note: "Use propose_content_plan for a plan outside a Work.",
        },
      };
    }

    // 2. The brief: this message, else the newest earlier one of the Work.
    const timezone = await getProjectTimezone(ctx.projectId);
    const today = todayInTimezone(timezone);
    const brief = parsePlanBrief(ctx.message) ?? ctx.planBriefFallback ?? null;
    if (!brief) {
      return {
        result: {
          error: NO_PLAN_BRIEF_ERROR,
          note: "Open the planning wizard with start_plan_brief, or call propose_content_plan when the client asked for one specific plan or a change to the open plan.",
        },
      };
    }

    // 3. The server fixes the calendar.
    const slots = layoutPlanSlots({
      brief,
      today,
      nowLocalTime: localTimeOf(timezone),
    });
    if (slots.length > MAX_OPTION_SLOTS) {
      return {
        result: {
          error: `Too many posts for directions (max ${MAX_OPTION_SLOTS}): call propose_content_plan with the full plan instead.`,
        },
      };
    }
    if (slots.length === 0) {
      return {
        result: {
          error: "The [Plan brief] leaves no posts to plan.",
          note: "Open the planning wizard with start_plan_brief.",
        },
      };
    }

    // 5. One idea per slot in every option.
    const shape = optionsShapeError(args, slots.length);
    if (shape) {
      // One repair round per turn: a model that keeps miscounting must not
      // loop through full re-sends (about 2.4k output tokens each).
      if ((ctx.shapeRepairs ?? 0) >= 1) {
        return {
          result: {
            error:
              "Stop: tell the client the directions could not be written and ask them to try again",
          },
        };
      }
      ctx.shapeRepairs = 1;
      return {
        result: {
          error: shape,
          note: `The posts, in order:\n${describePlanSlots(slots).join("\n")}\nFix the options and call propose_plan_options again.`,
        },
      };
    }

    // 6. Model text is untrusted: repair the markers, drop instruction-shaped text.
    const cleaned = cleanOptionsArgs(args);
    if (!cleaned.ok) return cleaningError(ctx, cleaned.failures, "directions");

    // 7. Brand rules over every idea of every option, one aggregated message.
    const rules = await loadRules(ctx);
    const brandCheck = brandCheckOf(rules);
    const perOption = slots.length;
    const flat: PlanTextItem[] = cleaned.args.options.flatMap(
      (option) => option.ideas,
    );
    const hits: ItemFlag[] = checkItems(flat, rules);
    if (blocksOf(hits).length > 0 && (ctx.brandRuleRepairs ?? 0) < 1) {
      ctx.brandRuleRepairs = 1;
      const message = brandRepairMessage(
        hits,
        (index) => {
          const slot: PlanSlot | undefined = slots[index % perOption];
          const letter =
            OPTION_LETTERS[Math.floor(index / perOption)]?.toLowerCase() ?? "?";
          return `option ${letter} idea ${(index % perOption) + 1} (${slot?.date}, ${slot?.formatKey})`;
        },
        "propose_plan_options",
        {
          closing:
            "Rewrite only those fields without the flagged wording, then call propose_plan_options again with ALL options. If the client themselves asked for this wording, do not repeat the options: tell them the brand rule blocks it and ask whether to change the rule.",
        },
      );
      if (message) {
        return {
          result: {
            error: message,
            note: "Fix the options and call propose_plan_options again.",
          },
        };
      }
    }

    // 8. A slot-first piece already owns this turn.
    if (ctx.planOwner === "slots") {
      return {
        result: {
          error:
            "A piece was already scheduled in this message, so a plan cannot be drafted in the same message.",
        },
      };
    }
    ctx.planOwner = "draft";

    // 9. Only the OPEN OPTIONS of this Work are replaced.
    await supersedeOpenPlanCards({
      projectId: ctx.projectId,
      exceptCommandId: ctx.commandId,
      workId: work.id,
      kinds: ["content-plan-options"],
    });

    // 10. The card ends the turn; the reply sentence is factual.
    const card = buildOptionsCard({
      args: { ...cleaned.args, goal: args.goal ?? brief.goal },
      slots,
      timezone,
      brandCheck,
    });
    const channels = channelListText([
      ...new Set(brief.channels.map(({ channel }) => channel)),
    ]);
    return {
      status: "ANSWERED",
      card,
      endTurn: true,
      appendReply: `Showed ${card.options.length} plan directions for ${channels} (${slots.length} posts each): ${card.options.map((o) => o.label).join("; ")}.`,
      result: {
        outcome: "plan_options_shown",
        note: "Stop here: the client picks a direction on the card. Do not describe the options.",
      },
    };
  },
});

// --- propose_ideas ---------------------------------------------------------

type IdeaDraft = { title: string; description: string };

const BACKLOG_STATUSES = [
  "SHORTLISTED",
  "CONCEPT",
  "VALIDATED",
  "APPROVED",
] as const;

// An existing idea as a card row; text that does not clean is skipped.
function cleanIdeaRow(row: {
  id: string;
  title: string;
  description: string;
}): IdeaOptionItem | null {
  const title = cleanWorksText(row.title, 120);
  const description = cleanWorksText(row.description, IDEA_TEXT_MAX);
  if (!title.ok || !description.ok) return null;
  return { ideaId: row.id, title: title.text, description: description.text };
}

const proposeIdeasTool = defineWorksTool<IdeaOptionsArgs>({
  name: "propose_ideas",
  label: "Preparing ideas…",
  kind: "note",
  // It saves new Idea rows: refused in a tainted turn.
  sensitive: true,
  phases: ["ACTIVE"],
  requiresWorks: true,
  description:
    "Show the client up to 3 content ideas as a card with a Plan it button each. Write ideas from the brand profile, its current focus and what worked (never generic). Pass includeBacklog: true to also show the best ideas already on the client's shortlist. reason is one short sentence on why these ideas. Saves new ideas to the Ideas list (an idea that is already there is reused); nothing is scheduled or produced. Ends your turn when it succeeds.",
  schema: IdeaOptionsArgsSchema,
  async execute(args, ctx) {
    // A slot-first piece already owns this turn's stored card; a second card
    // would be streamed and its ideas saved, then lost on reload.
    if (ctx.planOwner === "slots") {
      return {
        result: {
          error:
            "A piece was already scheduled in this message, so ideas cannot be shown in the same message.",
          note: "Finish with the scheduled piece; the client can ask for ideas next.",
        },
      };
    }

    // A note-kind tool has no duplicate guard for different arguments: the
    // second call of a turn must not save (or show) a second set. Claimed
    // before the first await and given back on a repairable error.
    if (ctx.ideasShown) {
      return { result: { error: "Ideas were already shown in this message." } };
    }
    ctx.ideasShown = true;
    const release = (outcome: ToolOutcome): ToolOutcome => {
      ctx.ideasShown = false;
      return outcome;
    };

    // Model text is untrusted: an idea that does not clean is dropped.
    const failures: CleanFailure[] = [];
    const drafts: IdeaDraft[] = [];
    args.ideas.forEach((idea, index) => {
      const title = cleanWorksText(idea.title, 120);
      const description = cleanWorksText(idea.description, IDEA_TEXT_MAX);
      const place = `Idea ${index + 1}`;
      if (!title.ok) {
        failures.push({
          place: `${place} (title)`,
          reason: reasonSentence(title.reason),
        });
      } else if (!description.ok) {
        failures.push({
          place: `${place} (description)`,
          reason: reasonSentence(description.reason),
        });
      } else {
        drafts.push({ title: title.text, description: description.text });
      }
    });
    if (drafts.length === 0 && !args.includeBacklog) {
      return release(cleaningError(ctx, failures, "ideas"));
    }

    // Brand rules over title and description, same once-per-turn repair.
    const rules = await loadRules(ctx);
    const hits = checkItems(
      drafts.map((d) => ({ topic: d.title, captionIdea: d.description })),
      rules,
    );
    if (blocksOf(hits).length > 0 && (ctx.brandRuleRepairs ?? 0) < 1) {
      ctx.brandRuleRepairs = 1;
      const message = brandRepairMessage(
        hits,
        (index) => `idea ${index + 1}`,
        "propose_ideas",
        {
          closing:
            "Rewrite only those ideas without the flagged wording, then call propose_ideas again. If the client themselves asked for this wording, do not repeat the ideas: tell them the brand rule blocks it and ask whether to change the rule.",
        },
      );
      if (message) {
        return release({
          result: {
            error: message,
            note: "Fix the ideas and call propose_ideas again.",
          },
        });
      }
    }

    // De-duplication: a repeated tap on "Give me ideas" must not pile up rows
    // until the active-idea cap is reached. A title already live is reused.
    const items: IdeaOptionItem[] = [];
    const used = new Set<string>();
    let saved = 0;
    let capped = false;
    if (drafts.length > 0) {
      const live = await prisma.idea.findMany({
        where: {
          projectId: ctx.projectId,
          status: { notIn: ["ARCHIVED", "REJECTED"] },
          isMock: false,
        },
        select: { id: true, title: true, description: true, status: true },
        take: MAX_LIVE_IDEAS,
      });
      const byTitle = new Map<string, (typeof live)[number]>();
      for (const row of live) {
        const key = foldForMatch(row.title);
        if (!byTitle.has(key)) byTitle.set(key, row);
      }

      const scope = {
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        brandId: ctx.brandId,
      };
      for (const draft of drafts) {
        if (items.length >= MAX_IDEAS_PER_CARD) break;
        const key = foldForMatch(draft.title);
        const existing = byTitle.get(key);
        if (existing) {
          if (used.has(existing.id)) continue;
          used.add(existing.id);
          items.push(
            cleanIdeaRow(existing) ?? {
              ideaId: existing.id,
              title: draft.title,
              description: draft.description,
            },
          );
          continue;
        }
        // Once the cap says no, every later save would say no too.
        if (capped) continue;
        const result = await saveIdea(scope, {
          title: draft.title,
          description: draft.description,
        });
        if (result.status === "CAPPED") {
          capped = true;
          continue;
        }
        saved++;
        used.add(result.ideaId);
        byTitle.set(key, {
          id: result.ideaId,
          title: draft.title,
          description: draft.description,
          status: "RAW",
        });
        items.push({
          ideaId: result.ideaId,
          title: draft.title,
          description: draft.description,
        });
      }
    }

    // The best existing ideas fill the card when asked for, and replace the
    // limit notice when nothing new could be saved.
    const wantsBacklog =
      args.includeBacklog === true || (drafts.length > 0 && saved === 0);
    if (wantsBacklog && items.length < MAX_IDEAS_PER_CARD) {
      const usedIds = [...used];
      const backlog = await prisma.idea.findMany({
        where: {
          projectId: ctx.projectId,
          status: { in: [...BACKLOG_STATUSES] },
          isMock: false,
          ...(usedIds.length > 0 ? { id: { notIn: usedIds } } : {}),
        },
        orderBy: [{ nbaScore: "desc" }, { createdAt: "desc" }],
        take: MAX_IDEAS_PER_CARD - items.length,
        select: { id: true, title: true, description: true },
      });
      for (const row of backlog) {
        if (items.length >= MAX_IDEAS_PER_CARD) break;
        const item = cleanIdeaRow(row);
        if (item) items.push(item);
      }
    }

    if (items.length === 0) {
      if (capped) {
        return {
          status: "ERROR",
          card: { kind: "limit-notice", reason: "active-ideas" },
          endTurn: true,
          result: {
            outcome: "blocked_idea_cap",
            explanation: limitNoticeReplyText({
              kind: "limit-notice",
              reason: "active-ideas",
            }),
          },
        };
      }
      return release({
        result: {
          error: "There are no ideas to show yet.",
          note: "Tell the client in one sentence that nothing is on the Ideas list yet, and ask what they want ideas for.",
        },
      });
    }

    const cleanedTitle = cleanWorksText(args.title, 80);
    const title = cleanedTitle.ok
      ? cleanedTitle.text
      : copyText("ideaOptions.titleDefault", {
          n: items.length,
          channels: ctx.work?.channels.length
            ? channelListText(ctx.work.channels)
            : "your brand",
        });
    const cleanedReason = args.reason ? cleanWorksText(args.reason, 140) : null;
    const card: IdeaOptionsCardData = {
      kind: "idea-options",
      title,
      reason: cleanedReason?.ok
        ? cleanedReason.text
        : copyText("ideaOptions.reasonDefault"),
      items,
      brandCheck: brandCheckOf(rules),
    };
    return {
      status: "ANSWERED",
      card,
      endTurn: true,
      appendReply: `Showed ${items.length} ideas: ${items
        .map((item) => item.title)
        .join("; ")}.`,
      result: {
        outcome: "ideas_shown",
        note: "Stop here: the client plans an idea with the Plan it button.",
      },
    };
  },
});

// A thrown error (a database hiccup after the turn's claim) gives the claim
// back, so the model's retry in the same message is not told ideas were shown.
const proposeIdeas: ChatTool = {
  ...proposeIdeasTool,
  async execute(args, ctx) {
    try {
      return await proposeIdeasTool.execute(args, ctx);
    } catch (error) {
      (ctx as WorksCtx).ideasShown = false;
      throw error;
    }
  },
};

// --- propose_master_content ------------------------------------------------

type MasterContentArgs = z.infer<typeof MasterContentArgsSchema>;

const proposeMasterContent = defineWorksTool<MasterContentArgs>({
  name: "propose_master_content",
  label: "Preparing your message…",
  kind: "note",
  phases: ["ACTIVE"],
  requiresWorks: true,
  description:
    "Write ONE main message (message, at most 600 characters, brand voice and language) the client can adapt to several channels and put on the calendar. title is a short name; cta an optional call to action; channels only when the client named some (default: all of the Work's channels except ads). Ends your turn when it succeeds.",
  schema: MasterContentArgsSchema,
  async execute(args, ctx) {
    const work = ctx.work;
    if (!work) {
      return {
        result: { error: "A main message only exists inside a Work." },
      };
    }

    // Model text is untrusted: repair markers, drop instruction-shaped text.
    const failures: CleanFailure[] = [];
    const clean = (raw: string, max: number, place: string): string => {
      const result = cleanWorksText(raw, max);
      if (result.ok) return result.text;
      failures.push({ place, reason: reasonSentence(result.reason) });
      return "";
    };
    const title = clean(args.title, 80, "The title");
    const message = clean(args.message, 600, "The message");
    const cta = args.cta ? clean(args.cta, 80, "The call to action") : "";
    if (failures.length > 0) return cleaningError(ctx, failures, "message");

    // Brand rules over title and message, same once-per-turn repair.
    const rules = await loadRules(ctx);
    const brandCheck = brandCheckOf(rules);
    const hits = checkItems([{ topic: title, captionIdea: message }], rules);
    if (blocksOf(hits).length > 0 && (ctx.brandRuleRepairs ?? 0) < 1) {
      ctx.brandRuleRepairs = 1;
      const repair = brandRepairMessage(
        hits,
        () => "the main message",
        "propose_master_content",
        {
          closing:
            "Rewrite the title and message without the flagged wording, then call propose_master_content again. If the client themselves asked for this wording, do not repeat it: tell them the brand rule blocks it and ask whether to change the rule.",
        },
      );
      if (repair) {
        return {
          result: {
            error: repair,
            note: "Fix the message and call propose_master_content again.",
          },
        };
      }
    }

    // A slot-first piece already owns this turn's stored card.
    if (ctx.planOwner === "slots") {
      return {
        result: {
          error:
            "A piece was already scheduled in this message, so a main message cannot be drafted in the same message.",
        },
      };
    }

    const card = buildMasterCard(
      { ...args, title, message, cta: cta || undefined },
      work.channels,
      brandCheck,
    );
    if (card.targets.length === 0) {
      return {
        result: {
          error: "This Work has no channel a main message can go to.",
          note: "Name the channels the client wants in channels.",
        },
      };
    }
    ctx.planOwner = "draft";
    // A newer main message replaces this Work's open ones ("make it
    // shorter"): only one card keeps live Adapt / Add to calendar buttons.
    await supersedeOpenPlanCards({
      projectId: ctx.projectId,
      exceptCommandId: ctx.commandId,
      workId: work.id,
      kinds: ["master-content"],
    });
    const channels = channelListText(
      card.targets.flatMap((t) => (isChannelKey(t.channel) ? [t.channel] : [])),
    );
    return {
      status: "ANSWERED",
      card,
      endTurn: true,
      appendReply: `Drafted the main message "${title}" for ${channels}.`,
      result: {
        outcome: "master_content_shown",
        note: "Stop here: the client adapts it to channels or adds it to the calendar on the card.",
      },
    };
  },
});

export const WORKS_ONLY_TOOLS: readonly ChatTool[] = [
  proposePlanOptions,
  proposeIdeas,
  proposeMasterContent,
];

// Appended to the static descriptions by tools.ts only while a Work exists.
export const WORKS_DESCRIPTION_SUFFIX: Record<
  "generate_image" | "create_task" | "propose_content_plan",
  string
> = {
  generate_image:
    " In a Work the piece is planned first: the tool puts it on the calendar at the next free day and renders it there, so the result is a planned slot, not a loose picture. Pictures are for Instagram only (Post 3:4 = FEED_PORTRAIT, Story 9:16 = STORY); a Reel is planned as a script, there is no square format, and text for LinkedIn, X, TikTok or the website is written with create_task. Report the planned day in one short sentence.",
  create_task:
    " In a Work, copy and briefs for a channel become planned calendar slots (LinkedIn, X, TikTok, Blog/SEO, Ads); an Instagram caption goes with its visual via generate_image. Publishing is not a task: approved pieces are published from their card.",
  propose_content_plan:
    " In a Work (a free chat) this is THE planning tool: call it right away for any plan request (defaults for whatever the client left out: the default channels, 3 posts per week for the next 7 days from tomorrow), and again with the full updated plan to change it. Every item carries its own channel and format. It stops your turn: the card shows the plan.",
};
