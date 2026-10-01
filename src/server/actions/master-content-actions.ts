"use server";

import {
  CHANNELS,
  defaultFormat,
  isChannelKey,
  isPlanGoal,
  type ChannelConnections,
  type ChannelKey,
} from "@/lib/content-channels";
import { prisma } from "@/lib/prisma";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import {
  blocksOf,
  brandCheckOf,
  checkItems,
  flagsForItem,
} from "@/lib/works/brand-rules";
import {
  NEUTRAL_IDEA_LABEL,
  cleanWorksTextOrNull,
} from "@/lib/works/clean-text";
import { copyText } from "@/lib/works/copy";
import {
  fallbackAdaptation,
  leadChannelOf,
  toPlanItems,
  type MasterContentCardData,
} from "@/lib/works/master-content";
import {
  validateSlotTargets,
  type SlotTargetInput,
} from "@/lib/works/slot-rules";
import {
  channelNeedsConnection,
  workSummaryFrom,
  type WorkView,
} from "@/lib/works/work";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { updateCardInTx, updateCommandCard } from "@/server/chat/card-store";
import { buildPlanCard, getProjectTimezone } from "@/server/chat/content-plan";
import { savePlanSlotsInTx } from "@/server/chat/save-plan-core";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { WorkRepository } from "@/server/repositories/work.repository";
import { isAgentelseError } from "@/server/security/errors";
import { loadBrandRules } from "@/server/works/brand-rule-loader";
import { planOutsideWork } from "@/server/works/channel-gate";
import {
  loadOccupiedSlots,
  loadSuggestedSlots,
} from "@/server/works/free-slot-loader";
import { isWorksEnabled } from "@/server/works/flag";
import {
  GUARD_MESSAGE,
  authorizeWorks,
  guardedAction,
  idSchema,
  refreshWorkPages,
  type WorksAuth,
} from "@/server/works/guard";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Card actions of the master-content card (spec 3.9.3): tick or untick a
// channel, add a channel to the Work, and turn the card into saved calendar
// slots. Every card write goes through the atomic card writer with
// requireActiveWork, and every Command is looked up first only to learn its
// project, then compared against it again (a foreign id is NOT_FOUND).
// 'use server': only async exports.

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type PlanItem = PlanCard["items"][number];

type SlotSuggestion = { channel: string; date: string; time: string };

export type ScheduleMasterResult =
  | {
      ok: true;
      commandId: string;
      slots: {
        channel: string;
        formatKey: string;
        date: string;
        time: string;
        creativeId: string;
      }[];
    }
  | {
      ok: false;
      code:
        | "DISABLED"
        | "RATE"
        | "NOT_FOUND"
        | "STATE"
        | "NO_TARGETS"
        | "STALE"
        | "BRAND_RULES"
        | "BUSY"
        | "WORK"
        | "FAILED";
      message: string;
      suggestion?: SlotSuggestion;
    };

export type ToggleMasterTargetResult =
  | { ok: true; included: boolean }
  | {
      ok: false;
      code:
        | "DISABLED"
        | "RATE"
        | "NOT_FOUND"
        | "STATE"
        | "NO_TARGETS"
        | "WORK"
        | "FAILED";
      message: string;
    };

export type AddMasterChannelResult =
  | { ok: true; channels: ChannelKey[] }
  | {
      ok: false;
      code: "DISABLED" | "RATE" | "NOT_FOUND" | "STATE" | "WORK" | "FAILED";
      message: string;
    };

const BUCKET = { bucket: "slots", limit: 30 } as const;
const NOT_FOUND_MESSAGE = "Card not found.";
const OUTSIDE_WORK_MESSAGE = copyText("master.channelOutside");
const TITLE_MAX = 90;
const REPLY_TITLE_MAX = 60;
const TOPIC_MAX = 120;
const CAPTION_MAX = 300;
const MATCHED_ECHO_MAX = 40;
const DAY_MS = 24 * 60 * 60_000;

// Thrown inside the transaction so everything written so far rolls back.
class MasterTxRefusal extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "WRONG_KIND"
      | "WORK_INACTIVE"
      | "CHANGED"
      | "STATE"
      | "FAILED",
    message: string,
  ) {
    super(message);
  }
}

function isWriteConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2034"
  );
}

function isMasterCard(card: unknown): card is MasterContentCardData {
  return (
    typeof card === "object" &&
    card !== null &&
    (card as { kind?: unknown }).kind === "master-content" &&
    Array.isArray((card as { targets?: unknown }).targets)
  );
}

function isOpen(card: MasterContentCardData): boolean {
  return card.state === "draft" || card.state === "adapted";
}

function cardOf(parsedIntent: unknown): unknown {
  return (parsedIntent as { card?: unknown } | null)?.card;
}

// The Command is looked up first only to learn its project.
async function lookCommand(commandId: unknown) {
  const parsed = idSchema.safeParse(commandId);
  if (!parsed.success) return null;
  const row = await prisma.command.findUnique({
    where: { id: parsed.data },
    select: { id: true, projectId: true, workId: true, parsedIntent: true },
  });
  return row?.projectId ? { ...row, projectId: row.projectId } : null;
}

// Access refusals are not told apart from a missing card.
async function authorizeFor(projectId: string) {
  try {
    return await authorizeWorks(projectId, BUCKET);
  } catch (error) {
    if (isAgentelseError(error)) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        message: NOT_FOUND_MESSAGE,
      };
    }
    throw error;
  }
}

async function bestEffort(label: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    console.error(
      `[works] ${label} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

// Which of the chosen channels are not connected right now ("I'll connect
// later"): stored so the screen can tell a deliberate choice from a gap. The
// same rule as setWorkChannelsAction.
async function unconnectedOf(
  projectId: string,
  channels: ChannelKey[],
): Promise<ChannelKey[]> {
  const connections: ChannelConnections = await getChannelConnections(
    projectId,
  ).catch(() => ({}));
  return channels.filter(
    (key) => channelNeedsConnection(key) && !connections[key]?.connected,
  );
}

function clockOf(timezone: string): { today: string; nowLocal: string } {
  const nowLocal = utcToZonedDateTimeLocal(new Date(), timezone);
  return { today: nowLocal.slice(0, 10), nowLocal };
}

// Calendar arithmetic on a "YYYY-MM-DD" key (no timezone involved).
function nextDay(date: string): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(ms + DAY_MS).toISOString().slice(0, 10);
}

async function freshSuggestion(
  projectId: string,
  channel: string,
): Promise<SlotSuggestion | undefined> {
  try {
    const result = await loadSuggestedSlots(projectId, { channel, count: 1 });
    const first = result.slots[0];
    return first ? { channel, date: first.date, time: first.time } : undefined;
  } catch {
    return undefined;
  }
}

type Text = { topic: string; captionIdea: string };

// The text every ticked target will carry: its adaptation, else the plain
// fallback, cleaned again (the card may be old or hand-edited).
function textsOf(card: MasterContentCardData): Text[] {
  const title = cleanWorksTextOrNull(card.master.title, TOPIC_MAX);
  return card.targets
    .filter((target) => target.included)
    .map((target) => {
      const text =
        target.adaptation ??
        fallbackAdaptation(card.master, target.channel, target.formatKey);
      const topic =
        cleanWorksTextOrNull(text.topic, TOPIC_MAX) ??
        title ??
        NEUTRAL_IDEA_LABEL;
      const captionIdea =
        cleanWorksTextOrNull(text.captionIdea, CAPTION_MAX) ?? topic;
      return { topic, captionIdea };
    });
}

// What was brand-checked: the transaction refuses when the card changed since.
function signatureOf(card: MasterContentCardData, texts: Text[]): string {
  return card.targets
    .filter((target) => target.included)
    .map(
      (target, i) =>
        `${target.channel}|${target.formatKey}|${texts[i]?.topic}|${texts[i]?.captionIdea}`,
    )
    .join("\n");
}

function labelsText(channels: readonly string[]): string {
  const labels = [
    ...new Set(
      channels.map((key) => (isChannelKey(key) ? CHANNELS[key].label : key)),
    ),
  ];
  if (labels.length <= 1) return labels[0] ?? "your channels";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

// A card that is already the saved plan of this master: the slots it holds.
function replayOf(
  parsedIntent: unknown,
  commandId: string,
): Extract<ScheduleMasterResult, { ok: true }> | null {
  const card = cardOf(parsedIntent) as PlanCard | null | undefined;
  if (
    !card ||
    card.kind !== "content-plan-draft" ||
    card.state !== "saved" ||
    card.via !== "master" ||
    !Array.isArray(card.items) ||
    !Array.isArray(card.savedCreativeIds)
  ) {
    return null;
  }
  const slots: Extract<ScheduleMasterResult, { ok: true }>["slots"] = [];
  card.items.forEach((item, index) => {
    const creativeId = card.savedCreativeIds?.[index];
    if (
      item.removed === true ||
      typeof creativeId !== "string" ||
      typeof item.channel !== "string" ||
      typeof item.formatKey !== "string"
    ) {
      return;
    }
    slots.push({
      channel: item.channel,
      formatKey: item.formatKey,
      date: item.date,
      time: item.time,
      creativeId,
    });
  });
  return { ok: true, commandId, slots };
}

type SlotChoice =
  | { ok: true; slots: { date: string; time: string }[] }
  | Extract<ScheduleMasterResult, { ok: false }>;

// Lead channel: the slot the person SAW when it is still valid and free, else
// the first free one. Every further channel: the next free slot of its own
// channel on a LATER day than the one before it, so one message never lands
// on two feeds in the same minute.
async function chooseSlots(input: {
  projectId: string;
  work: WorkView;
  targets: readonly MasterContentCardData["targets"][number][];
  lead: MasterContentCardData["targets"][number];
  leadSlot?: { date: string; time: string };
  timezone: string;
}): Promise<SlotChoice> {
  const { projectId, work, targets, lead, leadSlot, timezone } = input;
  const clock = clockOf(timezone);

  let first: { date: string; time: string } | undefined;
  if (leadSlot) {
    const verdict = validateSlotTargets({
      workChannels: work.channels,
      targets: [
        {
          channel: lead.channel,
          formatKey: lead.formatKey,
          date: leadSlot.date,
          time: leadSlot.time,
        },
      ],
      ...clock,
    });
    if (!verdict.ok) {
      if (verdict.code === "PAST") {
        return {
          ok: false,
          code: "STALE",
          message: verdict.message,
          suggestion: await freshSuggestion(projectId, lead.channel),
        };
      }
      return { ok: false, code: "FAILED", message: verdict.message };
    }
    const occupied = await loadOccupiedSlots(projectId, timezone);
    const taken = occupied.some(
      (slot) =>
        slot.date === leadSlot.date &&
        slot.time === leadSlot.time &&
        (slot.channel === undefined || slot.channel === lead.channel),
    );
    if (taken) {
      return {
        ok: false,
        code: "STALE",
        message: copyText("kit.stale"),
        suggestion: await freshSuggestion(projectId, lead.channel),
      };
    }
    first = { date: leadSlot.date, time: leadSlot.time };
  } else {
    const suggested = await loadSuggestedSlots(projectId, {
      channel: lead.channel,
      count: 1,
    });
    first = suggested.slots[0];
  }
  if (!first) {
    return { ok: false, code: "FAILED", message: copyText("slot.noFree") };
  }

  const slots: { date: string; time: string }[] = [];
  let previous = first;
  for (const target of targets) {
    if (target === lead) {
      slots.push(first);
      continue;
    }
    const suggested = await loadSuggestedSlots(projectId, {
      channel: target.channel,
      startFrom: nextDay(previous.date),
      count: 1,
    });
    const slot = suggested.slots[0];
    if (!slot) {
      return { ok: false, code: "FAILED", message: copyText("slot.noFree") };
    }
    slots.push(slot);
    previous = slot;
  }
  return { ok: true, slots };
}

export async function toggleMasterTargetAction(
  commandId: string,
  channel: string,
  included: boolean,
): Promise<ToggleMasterTargetResult> {
  const result = await guardedAction(
    "master-toggle",
    async (): Promise<ToggleMasterTargetResult> => {
      if (!isWorksEnabled()) {
        return { ok: false, code: "DISABLED", message: GUARD_MESSAGE.disabled };
      }
      if (typeof channel !== "string" || typeof included !== "boolean") {
        return { ok: false, code: "FAILED", message: GUARD_MESSAGE.failed };
      }
      const looked = await lookCommand(commandId);
      if (!looked) {
        return { ok: false, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
      }
      const { projectId } = looked;
      const gate = await authorizeFor(projectId);
      if (!gate.ok) {
        return {
          ok: false,
          code: gate.code === "INVALID" ? "FAILED" : gate.code,
          message: gate.message,
        };
      }

      let refusal: {
        code: "STATE" | "NO_TARGETS" | "NOT_FOUND";
        message: string;
      } | null = null;
      const refuse = (
        code: "STATE" | "NO_TARGETS" | "NOT_FOUND",
        message: string,
      ) => {
        refusal = { code, message };
        return { reject: message };
      };

      const written = await updateCommandCard({
        commandId,
        projectId,
        expectKinds: ["master-content"],
        requireActiveWork: true,
        update: (card) => {
          if (!isMasterCard(card) || !isOpen(card)) {
            return refuse("STATE", copyText("kit.stale"));
          }
          if (!card.targets.some((target) => target.channel === channel)) {
            return refuse("NOT_FOUND", NOT_FOUND_MESSAGE);
          }
          const targets = card.targets.map((target) =>
            target.channel === channel ? { ...target, included } : target,
          );
          // The last ticked channel stays ticked.
          if (!targets.some((target) => target.included)) {
            return refuse("NO_TARGETS", copyText("master.noTargets"));
          }
          if (
            targets.every((t, i) => t.included === card.targets[i]?.included)
          ) {
            return null;
          }
          return { ...card, targets };
        },
      });

      if (!written.ok) {
        switch (written.code) {
          case "NOT_FOUND":
            return { ok: false, code: "NOT_FOUND", message: written.message };
          case "WORK_INACTIVE":
            return { ok: false, code: "WORK", message: written.message };
          case "WRONG_KIND":
            return {
              ok: false,
              code: "STATE",
              message: copyText("kit.stale"),
            };
          case "REJECTED": {
            const reason = refusal as {
              code: "STATE" | "NO_TARGETS" | "NOT_FOUND";
              message: string;
            } | null;
            return {
              ok: false,
              code: reason?.code ?? "STATE",
              message: reason?.message ?? written.message,
            };
          }
          default:
            return { ok: false, code: "FAILED", message: written.message };
        }
      }
      refreshWorkPages(projectId);
      return { ok: true, included };
    },
  );
  return result.ok
    ? result
    : {
        ok: false,
        code: result.code === "INVALID" ? "FAILED" : result.code,
        message: result.message,
      };
}

export async function addMasterChannelAction(
  projectId: string,
  workId: string,
  commandId: string,
  channel: string,
): Promise<AddMasterChannelResult> {
  const result = await guardedAction(
    "master-add-channel",
    async (): Promise<AddMasterChannelResult> => {
      const gate = await authorizeFor(projectId);
      if (!gate.ok) {
        return {
          ok: false,
          code: gate.code === "INVALID" ? "FAILED" : gate.code,
          message: gate.message,
        };
      }
      const workIdOk = idSchema.safeParse(workId);
      const commandIdOk = idSchema.safeParse(commandId);
      if (!workIdOk.success || !commandIdOk.success || !isChannelKey(channel)) {
        return { ok: false, code: "FAILED", message: GUARD_MESSAGE.failed };
      }

      const work = await WorkRepository.get(projectId, workIdOk.data);
      if (!work) {
        return { ok: false, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
      }
      if (work.status !== "ACTIVE") {
        return { ok: false, code: "WORK", message: GUARD_MESSAGE.completed };
      }

      // The card must belong to THIS Work and still be open, before the
      // Work's channels change.
      const command = await prisma.command.findFirst({
        where: { id: commandIdOk.data, projectId, workId: work.id },
        select: { parsedIntent: true },
      });
      const stored = cardOf(command?.parsedIntent);
      if (!command) {
        return { ok: false, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
      }
      if (!isMasterCard(stored) || !isOpen(stored)) {
        return { ok: false, code: "STATE", message: copyText("kit.stale") };
      }

      // The same write as setWorkChannelsAction.
      const chosen = work.channels.includes(channel)
        ? work.channels
        : [...work.channels, channel];
      if (chosen !== work.channels) {
        const saved = await WorkRepository.setChannels(
          projectId,
          work.id,
          chosen,
          await unconnectedOf(projectId, chosen),
        );
        if (!saved) {
          return { ok: false, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
        }
      }

      const written = await updateCommandCard({
        commandId: commandIdOk.data,
        projectId,
        expectKinds: ["master-content"],
        requireActiveWork: true,
        update: (card) => {
          if (!isMasterCard(card) || !isOpen(card)) {
            return { reject: copyText("kit.stale") };
          }
          if (card.targets.some((target) => target.channel === channel)) {
            const ticked = card.targets.map((target) =>
              target.channel === channel
                ? { ...target, included: true }
                : target,
            );
            return ticked.every(
              (t, i) => t.included === card.targets[i]?.included,
            )
              ? null
              : { ...card, targets: ticked };
          }
          return {
            ...card,
            targets: [
              ...card.targets,
              {
                channel,
                formatKey: defaultFormat(channel).key,
                included: true,
              },
            ],
          };
        },
      });
      if (!written.ok) {
        return {
          ok: false,
          code:
            written.code === "WORK_INACTIVE"
              ? "WORK"
              : written.code === "NOT_FOUND"
                ? "NOT_FOUND"
                : "STATE",
          message: written.message,
        };
      }
      refreshWorkPages(projectId);
      return { ok: true, channels: chosen };
    },
  );
  return result.ok
    ? result
    : {
        ok: false,
        code: result.code === "INVALID" ? "FAILED" : result.code,
        message: result.message,
      };
}

export async function scheduleMasterAction(
  commandId: string,
  options?: {
    allowIssues?: boolean;
    leadSlot?: { date: string; time: string };
  },
): Promise<ScheduleMasterResult> {
  const result = await guardedAction(
    "master-schedule",
    async (): Promise<ScheduleMasterResult> => {
      if (!isWorksEnabled()) {
        return { ok: false, code: "DISABLED", message: GUARD_MESSAGE.disabled };
      }
      const allowIssues = options?.allowIssues === true;
      const leadSlot =
        typeof options?.leadSlot?.date === "string" &&
        typeof options.leadSlot.time === "string"
          ? { date: options.leadSlot.date, time: options.leadSlot.time }
          : undefined;
      if (options?.leadSlot !== undefined && !leadSlot) {
        return { ok: false, code: "FAILED", message: GUARD_MESSAGE.failed };
      }

      // 1. The Command (its project comes from the row), access, rate.
      const looked = await lookCommand(commandId);
      if (!looked || !looked.workId) {
        return { ok: false, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
      }
      const { projectId } = looked;
      const gate = await authorizeFor(projectId);
      if (!gate.ok) {
        return {
          ok: false,
          code: gate.code === "INVALID" ? "FAILED" : gate.code,
          message: gate.message,
        };
      }
      const { auth } = gate;

      // 2. The Work: this project's, and ACTIVE.
      const work = await WorkRepository.get(projectId, looked.workId);
      if (!work) {
        return { ok: false, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
      }
      if (work.status !== "ACTIVE") {
        return { ok: false, code: "WORK", message: GUARD_MESSAGE.completed };
      }

      // 3. Replay: the kind changed on the first success, so a second press
      // finds the saved plan and answers with its slots.
      const replay = replayOf(looked.parsedIntent, looked.id);
      if (replay) return replay;

      const card = cardOf(looked.parsedIntent);
      if (!isMasterCard(card) || !isOpen(card)) {
        return { ok: false, code: "STATE", message: copyText("kit.stale") };
      }
      const included = card.targets.filter((target) => target.included);
      if (included.length === 0) {
        return {
          ok: false,
          code: "NO_TARGETS",
          message: copyText("master.noTargets"),
        };
      }

      // 4. Channels must still belong to the Work.
      if (planOutsideWork(work, included)) {
        return { ok: false, code: "STATE", message: OUTSIDE_WORK_MESSAGE };
      }

      // 5. Brand rules over the final items.
      const texts = textsOf(card);
      const rules = await loadBrandRules({
        projectId,
        brandId: auth.defaultBrandId,
        language: await brandRuleLanguageOf(projectId),
      });
      const hits = checkItems(texts, rules);
      const blocks = blocksOf(hits);
      if (blocks.length > 0 && !allowIssues) {
        return {
          ok: false,
          code: "BRAND_RULES",
          message: copyText("brand.blockedSchedule"),
        };
      }
      const matched =
        allowIssues && blocks.length > 0
          ? blocks.map((block) => block.flag.matched.slice(0, MATCHED_ECHO_MAX))
          : [];

      // 6. Slots: the one the person saw, then the staggered rest.
      const connections = await getChannelConnections(projectId).catch(
        (): ChannelConnections => ({}),
      );
      const connected = new Set(
        Object.entries(connections)
          .filter(([, value]) => value?.connected)
          .map(([key]) => key),
      );
      const lead = leadChannelOf(card.targets, connected);
      if (!lead) {
        return {
          ok: false,
          code: "NO_TARGETS",
          message: copyText("master.noTargets"),
        };
      }
      const timezone = await getProjectTimezone(projectId);
      const chosen = await chooseSlots({
        projectId,
        work,
        targets: included,
        lead,
        leadSlot,
        timezone,
      });
      if (!chosen.ok) return chosen;

      const slotTargets: SlotTargetInput[] = included.map((target, i) => ({
        channel: target.channel,
        formatKey: target.formatKey,
        date: chosen.slots[i]?.date ?? "",
        time: chosen.slots[i]?.time ?? "",
      }));
      const verdict = validateSlotTargets({
        workChannels: work.channels,
        targets: slotTargets,
        ...clockOf(timezone),
      });
      if (!verdict.ok) {
        if (verdict.code === "PAST") {
          const channel = slotTargets[verdict.suggestIndex ?? 0]?.channel ?? "";
          return {
            ok: false,
            code: "STALE",
            message: verdict.message,
            suggestion: await freshSuggestion(projectId, channel),
          };
        }
        return { ok: false, code: "FAILED", message: verdict.message };
      }

      // 7. ONE Serializable transaction on the SAME Command: the card becomes
      // a content-plan-draft, then the save core writes the slots.
      const signature = signatureOf(card, texts);
      const title = cleanWorksTextOrNull(card.master.title, TITLE_MAX);
      const cardTitle = title ?? NEUTRAL_IDEA_LABEL;
      const replyTitle = (
        cleanWorksTextOrNull(card.master.title, REPLY_TITLE_MAX) ??
        NEUTRAL_IDEA_LABEL
      ).replace(/"/g, "'");
      const replyText = `Added the main message "${replyTitle}" to your calendar on ${labelsText(
        included.map((target) => target.channel),
      )}.`;

      let planItems: PlanItem[] = [];
      let committed: { creativeIds: string[] };
      try {
        committed = await prisma.$transaction(
          async (tx) => {
            const written = await updateCardInTx(tx, {
              commandId: looked.id,
              projectId,
              expectKinds: ["master-content"],
              requireActiveWork: true,
              update: (current) => {
                if (!isMasterCard(current) || !isOpen(current)) {
                  return { reject: "STATE" };
                }
                const currentTexts = textsOf(current);
                // Ticks or text changed since the brand check: not this press.
                if (signatureOf(current, currentTexts) !== signature) {
                  return { reject: "CHANGED" };
                }
                const planned = toPlanItems(
                  current.targets,
                  chosen.slots,
                  current.master,
                )
                  .map((item, i) => ({
                    ...item,
                    topic: currentTexts[i]?.topic ?? item.topic,
                    captionIdea:
                      currentTexts[i]?.captionIdea ?? item.captionIdea,
                    index: i,
                  }))
                  .sort((a, b) =>
                    `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`),
                  );
                const goal = isPlanGoal(current.master.goal)
                  ? current.master.goal
                  : undefined;
                const built = buildPlanCard(
                  {
                    title: cardTitle,
                    goal,
                    items: planned.flatMap((item) =>
                      isChannelKey(item.channel)
                        ? [
                            {
                              date: item.date,
                              time: item.time,
                              channel: item.channel,
                              formatKey: item.formatKey,
                              topic: item.topic,
                              captionIdea: item.captionIdea,
                            },
                          ]
                        : [],
                    ),
                  },
                  timezone,
                );
                if (built.items.length !== planned.length) {
                  return { reject: "FAILED" };
                }
                // buildPlanCard sorts with the same comparator: item i of the
                // built card is planned[i].
                planItems = built.items.map((item, i) => {
                  const flags = flagsForItem(hits, planned[i]?.index ?? -1);
                  return {
                    ...item,
                    origin: { kind: "master" as const, ref: looked.id },
                    ...(flags.length > 0 ? { brandFlags: flags } : {}),
                  };
                });
                const master: NonNullable<PlanCard["master"]> = {
                  title: current.master.title,
                  message: current.master.message,
                };
                if (current.master.ideaId) {
                  master.ideaId = current.master.ideaId;
                }
                const plan: PlanCard = {
                  ...built,
                  items: planItems,
                  via: "master",
                  master,
                  brandCheck: brandCheckOf(rules),
                };
                return { card: plan, replyText };
              },
            });
            if (!written.ok) {
              if (written.code === "REJECTED") {
                throw new MasterTxRefusal(
                  written.message === "CHANGED"
                    ? "CHANGED"
                    : written.message === "FAILED"
                      ? "FAILED"
                      : "STATE",
                  written.message,
                );
              }
              throw new MasterTxRefusal(
                written.code === "WORK_INACTIVE" ||
                  written.code === "WRONG_KIND" ||
                  written.code === "NOT_FOUND"
                  ? written.code
                  : "FAILED",
                written.message,
              );
            }
            const saved = await savePlanSlotsInTx(
              tx,
              {
                workspaceId: auth.workspaceId,
                projectId,
                brandId: auth.defaultBrandId,
              },
              looked.id,
            );
            if (!saved.ok) throw new MasterTxRefusal("FAILED", saved.error);
            return { creativeIds: saved.creativeIds };
          },
          { isolationLevel: "Serializable" },
        );
      } catch (error) {
        if (error instanceof MasterTxRefusal) {
          switch (error.code) {
            case "NOT_FOUND":
              return {
                ok: false,
                code: "NOT_FOUND",
                message: NOT_FOUND_MESSAGE,
              };
            case "WORK_INACTIVE":
              return {
                ok: false,
                code: "WORK",
                message: GUARD_MESSAGE.completed,
              };
            case "WRONG_KIND": {
              // A concurrent press may have won: answer with its slots.
              const row = await prisma.command.findUnique({
                where: { id: looked.id },
                select: { parsedIntent: true },
              });
              const won = replayOf(row?.parsedIntent, looked.id);
              return (
                won ?? {
                  ok: false,
                  code: "STATE",
                  message: copyText("kit.stale"),
                }
              );
            }
            case "CHANGED":
              return {
                ok: false,
                code: "BUSY",
                message: copyText("kit.stale"),
              };
            case "STATE":
              return {
                ok: false,
                code: "STATE",
                message: copyText("kit.stale"),
              };
            default:
              return {
                ok: false,
                code: "FAILED",
                message: GUARD_MESSAGE.failed,
              };
          }
        }
        if (isWriteConflict(error)) {
          return { ok: false, code: "BUSY", message: copyText("plan.saving") };
        }
        throw error;
      }

      // Everything below is best effort: the slots are already committed.
      const ideaId = card.master.ideaId;
      if (ideaId) {
        await bestEffort("advance idea", async () => {
          const idea = await IdeaRepository.findByIdInProject(
            ideaId,
            projectId,
          );
          if (
            idea &&
            idea.status !== "REJECTED" &&
            idea.status !== "ARCHIVED"
          ) {
            await IdeaRepository.advanceForScheduling(ideaId, projectId);
          }
        });
      }
      await bestEffort("touch work", () =>
        WorkRepository.touch(projectId, work.id, {
          summary: workSummaryFrom(cardTitle),
        }),
      );
      await bestEffort("audit master_content.scheduled", () =>
        recordAudit(auth, projectId, {
          action: "master_content.scheduled",
          entityType: "Command",
          entityId: looked.id,
          metadata: {
            channels: planItems.map((item) => item.channel),
            dates: planItems.map((item) => item.date),
            ...(matched.length > 0
              ? { allowIssues: true, matched, userId: auth.userId }
              : {}),
          },
        }),
      );
      refreshWorkPages(projectId, [`/projects/${projectId}/takvim`]);

      return {
        ok: true,
        commandId: looked.id,
        slots: planItems.flatMap((item, index) => {
          const creativeId = committed.creativeIds[index];
          return creativeId && item.channel && item.formatKey
            ? [
                {
                  channel: item.channel,
                  formatKey: item.formatKey,
                  date: item.date,
                  time: item.time,
                  creativeId,
                },
              ]
            : [];
        }),
      };
    },
  );
  return result.ok
    ? result
    : {
        ok: false,
        code: result.code === "INVALID" ? "FAILED" : result.code,
        message: result.message,
        ...("suggestion" in result && result.suggestion
          ? { suggestion: result.suggestion }
          : {}),
      };
}

function recordAudit(
  auth: WorksAuth,
  projectId: string,
  entry: {
    action: string;
    entityType: string;
    entityId: string;
    metadata: Record<string, unknown>;
  },
) {
  return AuditLogRepository.record({
    workspaceId: auth.workspaceId,
    projectId,
    brandId: auth.defaultBrandId,
    actorType: "USER",
    actorId: auth.userId,
    ...entry,
  });
}
