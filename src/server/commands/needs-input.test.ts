import { describe, expect, it } from "vitest";

import { ChatQuestionSchema } from "@/server/chat/constants";
import {
  missingCapabilityInput,
  type MissingCapabilityInput,
} from "@/server/execution/capability-input";

import { needsInputReply, platformQuestionCard } from "./needs-input";

// What the client sees when a request cannot become a task yet: one question
// with a button per platform, and the same thing as text for surfaces that show
// text.

const missing = missingCapabilityInput("SOCIAL_ACCOUNT_SETUP", {})!;
const unsupported = missingCapabilityInput("SOCIAL_ACCOUNT_SETUP", {
  platform: "FACEBOOK",
})!;

describe("platformQuestionCard", () => {
  const card = (m: MissingCapabilityInput = missing) =>
    platformQuestionCard({ projectId: "proj-1", ideaId: "idea-1", missing: m });

  it("is a question card scoped to the project and idea it was asked in", () => {
    expect(card()).toMatchObject({
      kind: "question",
      projectId: "proj-1",
      ideaId: "idea-1",
    });
  });

  it("has one button per platform a new account can be set up on", () => {
    const [question] = card().questions;

    expect(question!.options.map((o) => o.label)).toEqual([
      "Instagram",
      "TikTok",
      "LinkedIn",
    ]);
  });

  it("describes what each button does", () => {
    const [question] = card().questions;

    expect(question!.options[0]!.description).toBe(
      "Set up a new Instagram account",
    );
  });

  it("is valid for the chat question schema the client renders (2-4 options)", () => {
    expect(ChatQuestionSchema.safeParse(card().questions[0]).success).toBe(
      true,
    );
  });

  it("answers as a self-contained message: question and platform together", () => {
    // QuestionCard sends `${question} ${label}`.
    const [question] = card().questions;
    const message = `${question!.question} ${question!.options[1]!.label}`;

    expect(message).toBe(
      "Which platform should the new account be for? TikTok",
    );
  });

  it("says so when the platform given cannot be used", () => {
    expect(card(unsupported).questions[0]!.question).toBe(
      "A new account can't be set up on FACEBOOK. Which platform should the new account be for?",
    );
  });

  it("works without an idea", () => {
    expect(
      platformQuestionCard({ projectId: "proj-1", missing }).ideaId,
    ).toBeUndefined();
  });
});

describe("needsInputReply", () => {
  it("asks the question in words, with the choices", () => {
    expect(needsInputReply(missing)).toBe(
      "Which platform should the new account be for? Instagram, TikTok or LinkedIn?",
    );
  });

  it("says what to do when the task already exists and could not be approved", () => {
    const reply = needsInputReply({ ...missing, approvalId: "appr-1" });

    expect(reply).toContain("Reject it and ask again");
    expect(reply).not.toContain(
      "Which platform should the new account be for?",
    );
  });
});
