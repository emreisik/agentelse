import {
  accountSetupPlatformName,
  missingInputAdvice,
  type MissingCapabilityInput,
} from "@/server/execution/capability-input";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// What the client is told when a request cannot become a task yet because an
// input free text did not carry is missing (see execution/capability-input.ts):
// one question with one button per allowed platform, so the answer is a click
// instead of a second attempt at typing it. Shared by every door that can start
// a task, so they all ask the same thing the same way.

export type NeedsInput = MissingCapabilityInput & {
  // Set when the task already exists and was about to be approved (it predates
  // the check, or was made elsewhere): nothing to ask, the approval has to be
  // rejected and the request made again.
  approvalId?: string;
};

function questionText(missing: MissingCapabilityInput): string {
  const ask = "Which platform should the new account be for?";
  return missing.problem === "unsupported"
    ? `A new account can't be set up on ${missing.got}. ${ask}`
    : ask;
}

// The button card. Answering sends "<question> <platform>" as an ordinary chat
// message (QuestionCard), so it works the same under both chat engines.
export function platformQuestionCard(input: {
  projectId: string;
  ideaId?: string;
  missing: MissingCapabilityInput;
}): Extract<IdeaEventCardData, { kind: "question" }> {
  return {
    kind: "question",
    questions: [
      {
        question: questionText(input.missing),
        options: input.missing.allowed.map((platform) => ({
          label: accountSetupPlatformName(platform),
          description: `Set up a new ${accountSetupPlatformName(platform)} account`,
        })),
      },
    ],
    projectId: input.projectId,
    ideaId: input.ideaId,
  };
}

// The text twin of the card, for surfaces that show text: the reply stored on
// the Command and read back as history.
export function needsInputReply(needs: NeedsInput): string {
  if (needs.approvalId) return missingInputAdvice(needs);
  const names = needs.allowed.map(accountSetupPlatformName);
  const list = `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return `${questionText(needs)} ${list}?`;
}
