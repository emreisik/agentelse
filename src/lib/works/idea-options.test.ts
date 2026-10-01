import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  IdeaOptionsArgsSchema,
  MAX_IDEAS_PER_CARD,
  ideaTargetFields,
} from "./idea-options";

const idea = { title: "A title", description: "A description" };

describe("IdeaOptionsArgsSchema", () => {
  it("needs ideas or includeBacklog", () => {
    expect(IdeaOptionsArgsSchema.safeParse({ title: "T", ideas: [] }).success).toBe(false);
    expect(
      IdeaOptionsArgsSchema.safeParse({ title: "T", ideas: [], includeBacklog: false }).success,
    ).toBe(false);
    expect(
      IdeaOptionsArgsSchema.safeParse({ title: "T", ideas: [], includeBacklog: true }).success,
    ).toBe(true);
    expect(IdeaOptionsArgsSchema.safeParse({ title: "T", ideas: [idea] }).success).toBe(true);
  });

  it("caps ideas and field lengths", () => {
    expect(MAX_IDEAS_PER_CARD).toBe(3);
    expect(
      IdeaOptionsArgsSchema.safeParse({ title: "T", ideas: [idea, idea, idea, idea] }).success,
    ).toBe(false);
    expect(
      IdeaOptionsArgsSchema.safeParse({
        title: "T",
        ideas: [{ title: "x".repeat(121), description: "d" }],
      }).success,
    ).toBe(false);
    expect(
      IdeaOptionsArgsSchema.safeParse({
        title: "T",
        reason: "r".repeat(141),
        ideas: [idea],
      }).success,
    ).toBe(false);
  });

  it("is representable as JSON schema", () => {
    expect(() => z.toJSONSchema(IdeaOptionsArgsSchema)).not.toThrow();
  });
});

describe("ideaTargetFields", () => {
  it("prefers the concept execution sketch over the description", () => {
    expect(
      ideaTargetFields({ ...idea, concept: { executionSketch: "Film the   team\nat work" } }),
    ).toEqual({ topic: "A title", captionIdea: "Film the team at work" });
  });

  it("falls back to the description for a missing or empty sketch", () => {
    for (const concept of [undefined, null, "x", {}, { executionSketch: "  " }, { executionSketch: 4 }]) {
      expect(ideaTargetFields({ ...idea, concept }).captionIdea).toBe("A description");
    }
  });

  it("clips the topic at 120 and the caption at 300", () => {
    const out = ideaTargetFields({
      title: "t".repeat(200),
      description: "d".repeat(500),
    });
    expect(Array.from(out.topic)).toHaveLength(120);
    expect(Array.from(out.captionIdea)).toHaveLength(300);
  });
});
