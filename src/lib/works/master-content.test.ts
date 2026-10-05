import { describe, expect, it } from "vitest";
import * as z from "zod";
import { CHANNELS, type ChannelKey } from "@/lib/content-channels";
import {
  MasterContentArgsSchema,
  buildMasterCard,
  captionIdeaLimit,
  chipStates,
  defaultTargets,
  fallbackAdaptation,
  leadChannelOf,
  toPlanItems,
  type MasterTarget,
} from "./master-content";

describe("defaultTargets", () => {
  it("skips ads and uses each channel's default format", () => {
    const targets = defaultTargets(["instagram", "ads", "linkedin"]);
    expect(targets.map((t) => t.channel)).toEqual(["instagram", "linkedin"]);
    expect(targets.every((t) => t.included)).toBe(true);
    expect(targets[0]!.formatKey).toBe(CHANNELS.instagram.formats[0]!.key);
  });
  it("honours an explicit list, even with ads", () => {
    expect(defaultTargets(["instagram", "ads"], ["ads"]).map((t) => t.channel)).toEqual(["ads"]);
  });
});

describe("buildMasterCard", () => {
  it("builds a draft with default targets", () => {
    const card = buildMasterCard({ title: "T", message: "M" }, ["instagram", "ads"]);
    expect(card.kind).toBe("master-content");
    expect(card.state).toBe("draft");
    expect(card.targets.map((t) => t.channel)).toEqual(["instagram"]);
    expect(card.master).toEqual({ title: "T", message: "M" });
    expect(card.brandCheck).toBeUndefined();
  });
  it("uses explicit channels, optional fields and the brand check", () => {
    const card = buildMasterCard(
      { title: "T", message: "M", cta: "Go", goal: "leads", ideaId: "i1", channels: ["x"] },
      ["instagram"],
      { state: "skipped" },
    );
    expect(card.targets.map((t) => t.channel)).toEqual(["x"]);
    expect(card.master).toMatchObject({ cta: "Go", goal: "leads", ideaId: "i1" });
    expect(card.brandCheck).toEqual({ state: "skipped" });
  });
});

describe("leadChannelOf", () => {
  const t = (channel: string, included = true): MasterTarget => ({ channel, formatKey: "x", included });
  it("prefers the first included connected social channel", () => {
    const targets = [t("seo"), t("linkedin"), t("instagram")];
    expect(leadChannelOf(targets, new Set(["instagram"]))?.channel).toBe("instagram");
  });
  it("falls back to the first included, ignores unticked", () => {
    expect(leadChannelOf([t("x", false), t("seo")], new Set())?.channel).toBe("seo");
    expect(leadChannelOf([t("x", false)], new Set())).toBeUndefined();
  });
});

describe("chipStates", () => {
  const workChannels: { key: ChannelKey; connected: boolean }[] = [
    { key: "instagram", connected: true },
    { key: "linkedin", connected: false },
    { key: "seo", connected: false },
    { key: "ads", connected: false },
  ];
  const targets = defaultTargets(["instagram", "linkedin", "seo", "ads"]);
  const chips = chipStates({ targets, workChannels, projectId: "p1" });
  const by = (k: string) => chips.find((c) => c.key === k)!;

  it("derives every state live", () => {
    expect(by("instagram").state).toBe("included");
    expect(by("linkedin").state).toBe("locked");
    expect(by("linkedin").connectHref).toBe("/projects/p1/integrations?integration=linkedin");
    expect(by("seo").state).toBe("included");
    expect(by("ads").state).toBe("excluded");
    expect(by("tiktok").state).toBe("outside");
    expect(by("tiktok").connectHref).toBeUndefined();
  });
  it("labels only seo as Website and never offers email", () => {
    expect(by("seo").label).toBe("Website");
    expect(by("instagram").label).toBe(CHANNELS.instagram.label);
    expect(CHANNELS.seo.label).not.toBe("Website");
    expect(chips.map((c) => c.key as string)).not.toContain("email");
  });
});

describe("fallbackAdaptation / toPlanItems", () => {
  const master = { title: "x".repeat(200), message: "m".repeat(500) };
  it("clamps to each format limit", () => {
    const a = fallbackAdaptation(master, "instagram", "instagram.post");
    expect(a.topic).toHaveLength(120);
    expect(a.captionIdea).toHaveLength(200);
    expect(fallbackAdaptation(master, "x", "x.post").captionIdea).toHaveLength(240);
    expect(captionIdeaLimit("instagram.post")).toBe(200);
  });
  it("builds one item per ticked target, adaptation before fallback", () => {
    const targets: MasterTarget[] = [
      { channel: "instagram", formatKey: "instagram.post", included: true, adaptation: { topic: "A", captionIdea: "B" } },
      { channel: "x", formatKey: "x.post", included: false },
      { channel: "linkedin", formatKey: "linkedin.post", included: true },
    ];
    const items = toPlanItems(
      targets,
      [{ date: "2026-10-05", time: "10:00" }, { date: "2026-10-06", time: "11:00" }],
      { title: "Title", message: "Msg" },
    );
    expect(items).toEqual([
      // One idea, one post: every channel carries the master's title.
      { date: "2026-10-05", time: "10:00", channel: "instagram", formatKey: "instagram.post", topic: "Title", captionIdea: "B" },
      { date: "2026-10-06", time: "11:00", channel: "linkedin", formatKey: "linkedin.post", topic: "Title", captionIdea: "Msg" },
    ]);
  });
});

describe("MasterContentArgsSchema", () => {
  it("accepts and rejects", () => {
    expect(MasterContentArgsSchema.safeParse({ title: "a", message: "b" }).success).toBe(true);
    expect(MasterContentArgsSchema.safeParse({ title: "", message: "b" }).success).toBe(false);
    expect(MasterContentArgsSchema.safeParse({ title: "a", message: "b".repeat(601) }).success).toBe(false);
    expect(MasterContentArgsSchema.safeParse({ title: "a", message: "b", channels: ["email"] }).success).toBe(false);
    expect(MasterContentArgsSchema.safeParse({ title: "a", message: "b", goal: "leads" }).success).toBe(true);
  });
  it("converts to JSON schema", () => {
    expect(() => z.toJSONSchema(MasterContentArgsSchema)).not.toThrow();
  });
});
