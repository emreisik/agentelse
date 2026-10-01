import "server-only";

import { CHANNELS, isChannelKey, resolveFormat } from "@/lib/content-channels";
import { prisma } from "@/lib/prisma";
import {
  blocksOf,
  brandRepairMessage,
  checkItems,
  type BrandFlag,
  type BrandRuleSet,
  type ItemFlag,
} from "@/lib/works/brand-rules";
import { cleanWorksTextOrNull, flattenRuleText } from "@/lib/works/clean-text";
import { copyText } from "@/lib/works/copy";
import {
  captionIdeaLimit,
  type MasterContentCardData,
  type MasterTarget,
} from "@/lib/works/master-content";
import { getBrandTwin } from "@/server/brand-twin/brand-twin";
import {
  limitNoticeFromError,
  limitNoticeReplyText,
} from "@/server/commands/limit-notice";
import {
  contentAdaptMasterDef,
  type ContentAdaptMaster,
} from "@/server/reasoning/prompts/content-adapt-master";
import { ReasoningService } from "@/server/reasoning/reasoning-service";

// Model side of "Adapt to channels" (spec 3.9.2): ONE reasoning call that
// rewrites the master message per ticked channel, plus at most one repair call
// when a brand rule is broken. It never writes: the route owns the claim and
// the card write, so a failure here leaves the stored card untouched.

const TOPIC_LIMIT = 120;
const MASTER_TITLE_LIMIT = 120;
const MASTER_MESSAGE_LIMIT = 600;
const MASTER_CTA_LIMIT = 80;
const MAX_PROMPT_RULES = 12;
const MAX_CALENDAR_TOPICS = 10;
const MAX_ISSUE_TEXT = 160;

export type MasterAdaptScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type MasterAdaptResult =
  | { ok: true; card: MasterContentCardData }
  | {
      ok: false;
      code: "MOCK" | "FAILED" | "BUDGET" | "NOTHING";
      message: string;
    };

type Row = {
  target: MasterTarget;
  topic: string;
  captionIdea: string;
};

// Rule and claim text goes to the model flattened and clipped, never judged:
// the instruction filter would drop "Never mention competitors by name".
function ruleTexts(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = flattenRuleText(value, 120);
    if (text) out.push(text);
    if (out.length >= MAX_PROMPT_RULES) break;
  }
  return out;
}

// The asked targets, in card order: ticked, in the catalog, and exactly the
// channel + format the card holds (a request cannot invent a format).
function askedTargets(
  card: MasterContentCardData,
  asked: readonly { channel: string; formatKey: string }[] | undefined,
): MasterTarget[] {
  return card.targets.filter((target) => {
    if (!target.included || !isChannelKey(target.channel)) return false;
    if (!resolveFormat(target.channel, target.formatKey)) return false;
    return (
      !asked ||
      asked.some(
        (a) => a.channel === target.channel && a.formatKey === target.formatKey,
      )
    );
  });
}

async function calendarTopics(
  scope: MasterAdaptScope,
  commandId: string,
  channels: readonly string[],
): Promise<string[]> {
  try {
    const rows = await prisma.creative.findMany({
      where: {
        projectId: scope.projectId,
        channel: { in: [...channels] },
        scheduledFor: { gte: new Date() },
        status: { notIn: ["ARCHIVED", "REJECTED"] },
      },
      orderBy: { scheduledFor: "asc" },
      take: MAX_CALENDAR_TOPICS + 4,
      select: { title: true, planId: true },
    });
    const topics: string[] = [];
    for (const row of rows) {
      // Posts of this very card (an earlier schedule of it) are not "other".
      if (row.planId === commandId) continue;
      const topic = cleanWorksTextOrNull(row.title, TOPIC_LIMIT);
      if (topic) topics.push(topic);
      if (topics.length >= MAX_CALENDAR_TOPICS) break;
    }
    return topics;
  } catch (error) {
    console.error(
      "[works] master adapt calendar read failed:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

// Catalog validation + cleaning of one model answer. A row the catalog does not
// know, for a target nobody asked for, repeated, or cleaned to nothing is
// dropped (the target then keeps the plain fallback at scheduling time).
function rowsOf(
  output: ContentAdaptMaster,
  asked: readonly MasterTarget[],
): Row[] {
  const rows: Row[] = [];
  const seen = new Set<MasterTarget>();
  for (const adaptation of output.adaptations) {
    const target = asked.find(
      (t) =>
        t.channel === adaptation.channel &&
        t.formatKey === adaptation.formatKey,
    );
    if (!target || seen.has(target)) continue;
    const topic = cleanWorksTextOrNull(adaptation.topic, TOPIC_LIMIT);
    const captionIdea = cleanWorksTextOrNull(
      adaptation.captionIdea,
      captionIdeaLimit(target.formatKey),
    );
    if (!topic || !captionIdea) continue;
    seen.add(target);
    rows.push({ target, topic, captionIdea });
  }
  return rows;
}

function echo(text: string): string {
  return flattenRuleText(text, MAX_ISSUE_TEXT) ?? "";
}

// Card-facing sentence of one flag (copy.md `brand.flag.*`).
function issueText(flag: BrandFlag): string {
  const matched = echo(flag.matched);
  const rule = echo(flag.rule ?? "");
  switch (flag.kind) {
    case "never-term":
      return copyText("brand.flag.never", { matched, rule });
    case "preset":
      return copyText("brand.flag.preset", { rule });
    case "figure":
      return copyText("brand.flag.figure", { matched });
    case "absolute":
      return copyText("brand.flag.absolute", { matched });
  }
}

function issuesByRow(hits: readonly ItemFlag[]): Map<number, string[]> {
  const byRow = new Map<number, string[]>();
  for (const { index, flag } of hits) {
    const text = issueText(flag);
    const list = byRow.get(index) ?? [];
    if (!list.includes(text)) list.push(text);
    byRow.set(index, list);
  }
  return byRow;
}

function buildCard(
  card: MasterContentCardData,
  rows: readonly Row[],
  hits: readonly ItemFlag[],
): MasterContentCardData {
  const issues = issuesByRow(hits);
  const byTarget = new Map<MasterTarget, MasterTarget["adaptation"]>();
  rows.forEach((row, index) => {
    const adaptation: NonNullable<MasterTarget["adaptation"]> = {
      topic: row.topic,
      captionIdea: row.captionIdea,
    };
    const list = issues.get(index);
    if (list && list.length > 0) adaptation.issues = list;
    byTarget.set(row.target, adaptation);
  });
  return {
    ...card,
    state: "adapted",
    // Only the asked targets change; every other row stays as it was.
    targets: card.targets.map((target) => {
      const adaptation = byTarget.get(target);
      return adaptation ? { ...target, adaptation } : target;
    }),
  };
}

export async function runMasterAdapt(input: {
  scope: MasterAdaptScope;
  card: MasterContentCardData;
  commandId: string;
  targets?: readonly { channel: string; formatKey: string }[];
  language: string;
  rules: BrandRuleSet | null;
}): Promise<MasterAdaptResult> {
  const { scope, card, commandId, language, rules } = input;

  // A mock answer must never be written into a real card.
  if (ReasoningService.isMockMode()) {
    return { ok: false, code: "MOCK", message: copyText("master.adaptMock") };
  }

  const asked = askedTargets(card, input.targets);
  const title = cleanWorksTextOrNull(card.master.title, MASTER_TITLE_LIMIT);
  const message = cleanWorksTextOrNull(
    card.master.message,
    MASTER_MESSAGE_LIMIT,
  );
  if (asked.length === 0 || !title || !message) {
    return {
      ok: false,
      code: "NOTHING",
      message: copyText("master.noTargets"),
    };
  }

  const [twin, topicsOnCalendar] = await Promise.all([
    getBrandTwin(scope.projectId, { memory: false }).catch(() => null),
    calendarTopics(
      scope,
      commandId,
      asked.map((target) => target.channel),
    ),
  ]);

  const facts = {
    language,
    master: {
      title,
      message,
      cta: cleanWorksTextOrNull(card.master.cta, MASTER_CTA_LIMIT),
      goal: card.master.goal ?? null,
    },
    targets: asked.map((target) => {
      const channel = CHANNELS[target.channel as keyof typeof CHANNELS];
      const format = resolveFormat(channel.key, target.formatKey);
      return {
        channel: target.channel,
        formatKey: target.formatKey,
        label: `${channel.label} ${format?.label ?? ""}`.trim(),
        limit: captionIdeaLimit(target.formatKey),
      };
    }),
    // Through flattenRuleText ONLY: safeModelText would drop "Never mention ..."
    neverRules: ruleTexts(rules?.never.map((rule) => rule.text) ?? []),
    approvedClaims: ruleTexts(rules?.approvedClaims ?? []),
    voice: {
      personality: cleanWorksTextOrNull(twin?.voice.personality, 160),
      toneOfVoice: cleanWorksTextOrNull(twin?.voice.toneOfVoice, 160),
    },
    positioning: cleanWorksTextOrNull(twin?.positioning, 200),
    currentFocus: cleanWorksTextOrNull(twin?.currentFocus?.title, 120),
    calendarTopics: topicsOnCalendar,
  };

  const run = (repair?: string) =>
    ReasoningService.run(contentAdaptMasterDef, {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      context: repair ? { facts, repair } : { facts },
    });

  let rows: Row[];
  try {
    const { output } = await run();
    rows = rowsOf(output, asked);
  } catch (error) {
    const notice = limitNoticeFromError(error);
    if (notice) {
      return {
        ok: false,
        code: "BUDGET",
        message: limitNoticeReplyText(notice),
      };
    }
    console.error(
      "[works] master adapt failed:",
      error instanceof Error ? error.message : error,
    );
    return {
      ok: false,
      code: "FAILED",
      message: copyText("master.adaptFailed"),
    };
  }
  if (rows.length === 0) {
    return {
      ok: false,
      code: "FAILED",
      message: copyText("master.adaptFailed"),
    };
  }

  let hits = checkItems(rows, rules);
  const repair = brandRepairMessage(
    hits,
    (index) => {
      const target = rows[index]?.target;
      return target
        ? `Adaptation ${index + 1} (${target.channel}, ${target.formatKey})`
        : `Adaptation ${index + 1}`;
    },
    "the adaptation",
    {
      closing:
        "Rewrite only those fields without the flagged wording, keep the channel and formatKey of every adaptation, and return the FULL list of adaptations again.",
    },
  );

  if (repair && blocksOf(hits).length > 0) {
    try {
      const { output } = await run(repair);
      const repaired = rowsOf(output, asked);
      if (repaired.length > 0) {
        rows = repaired;
        hits = checkItems(rows, rules);
      }
    } catch (error) {
      // Fail open, visibly: the first answer is kept and carries its issues.
      console.error(
        "[works] master adapt repair failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { ok: true, card: buildCard(card, rows, hits) };
}
