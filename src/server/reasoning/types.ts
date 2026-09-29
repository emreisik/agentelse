import type { ZodType } from "zod";

// A ReasoningDef packages one engine-internal LLM purpose: its output schema,
// how to build the real prompt from caller-frozen context, and how to build a
// deterministic mock output from that same context. Mock builders MUST derive
// everything from the input (never hardcode brand content) so tests exercise
// real data flow, and every mock output is marked isMock by the service.
export type ReasoningContext = Record<string, unknown>;

export type ReasoningDef<TOut> = {
  purpose: string;
  schema: ZodType<TOut>;
  buildPrompt(context: ReasoningContext): { system: string; user: string };
  buildMock(context: ReasoningContext): TOut;
  // Cost/quality tier. "lite" for high-volume mechanical steps (idea
  // generation, signal scoring), "pro" for rare but critical syntheses.
  // If unspecified, the project-wide default model is used.
  tier?: "lite" | "default" | "pro";
  // Escape hatch to bypass the tier and pin a specific model.
  model?: string;
  maxTokens?: number;
  // The model may search the live web while answering (OpenAI backend only;
  // costs a per-search fee on top of tokens). Ignored on other backends and in
  // mock mode, where buildMock stands in.
  webSearch?: boolean;
};

export type ReasoningInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  context: ReasoningContext;
  // Multi-modal input (image/PDF/text the user attached to the chat).
  // Used only on the real call path; the mock path never sees these, so
  // buildMock always keeps deriving solely from context.
  attachments?: { mimeType: string; data: string }[];
};

export type ReasoningResult<TOut> = {
  output: TOut;
  isMock: boolean;
  reasoningCallId: string;
};
