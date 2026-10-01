// One log line per chat turn that says where its time went, so a slow reply can
// be pinned on the right stage instead of guessed at:
//   pre_model    request start -> first model call (DB reads, quick discovery)
//   first_token  request start -> first streamed token (what the client waits for)
//   model_loop   first model call -> last model call done (includes tool runs)
//   tail         last model call done -> now (reply and usage writes)
// `cached` is the part of `in` OpenAI served from its prompt cache.
export type TurnTiming = {
  ok: boolean;
  startedAt: number;
  modelStartedAt: number;
  firstTokenAt: number;
  modelEndedAt: number;
  rounds: number;
  // Every tool the model called, in order; each extra round is usually one.
  tools: readonly string[];
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export function formatTurnTiming(timing: TurnTiming, now = Date.now()): string {
  const span = (from: number, to: number) =>
    from && to ? `${to - from}ms` : "-";
  const parts = [
    `ok=${timing.ok}`,
    `pre_model=${span(timing.startedAt, timing.modelStartedAt)}`,
    `first_token=${span(timing.startedAt, timing.firstTokenAt)}`,
    `model_loop=${span(timing.modelStartedAt, timing.modelEndedAt)}`,
    `tail=${span(timing.modelEndedAt, now)}`,
    `total=${now - timing.startedAt}ms`,
    `rounds=${timing.rounds}`,
    `tools=${timing.tools.length ? timing.tools.join(",") : "-"}`,
    `in=${timing.inputTokens}`,
    `cached=${timing.cachedInputTokens}`,
    `out=${timing.outputTokens}`,
  ];
  return `[chat-timing] ${parts.join(" ")}`;
}

export function logTurnTiming(timing: TurnTiming): void {
  console.info(formatTurnTiming(timing));
}
